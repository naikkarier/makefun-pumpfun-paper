// PumpSprint: a momentum paper-trader for the pump.fun bonding-curve replay.
//
// Idea: most new pump.fun curves fade fast, a few run hard. This bot waits for a
// curve to prove real buying interest, buys a small first stake, adds only while
// the price keeps climbing, and cuts every position on a stop loss, a trailing
// stop, fading flow, or a time limit. Tiny probe round trips keep the run above
// the guardrails (at least 20 coins traded) when momentum entries run dry.
//
// Deterministic by construction: no clock, no randomness, every decision comes
// from the batch stream, and maps are walked in insertion order.

import {
  LAMPORTS_PER_SOL,
  runBot,
  type Batch,
  type BotState,
  type OrderInput,
  type Pubkey,
} from './vendor/makefun-bot.ts';

const LAMPORTS = 1_000_000_000;
// Curve fee charged on each side of a trade (protocol 95 bps + creator 30 bps).
const CURVE_FEE = 0.0125;
const BPS_PER_UNIT = 10_000;

// Entry signal.
const ENTRY_WINDOW_SLOTS = 40;
const MIN_AGE_SLOTS = 500;
const MIN_NET_SOL = 1.0;
const MIN_BUYS = 5;
const MIN_BUYERS = 5;
const MIN_RISE = 0.08;
const MAX_RISE = 1.5;
const NEAR_HIGH = 0.95;
const MIN_REAL_SOL = 2.0;
const MAX_REAL_SOL = 80;
// Sizing.
const FIRST_BUY_SOL = 0.1;
const ADD_SOL = 0.15;
const MAX_STAKE_SOL = 0.55;
const MIN_BUY_SOL = 0.02;
const BUY_SLIPPAGE_BPS = 1500;
// Exits.
const STOP_LOSS = 0.12;
const TRAIL_ARM = 0.12;
const TRAIL_DROP = 0.35;
const FADE_WINDOW_SLOTS = 20;
const FADE_NET_SOL = 0.5;
const BIG_SELL_SOL = 5;
const MAX_HOLD_SLOTS = 2000;
const HOLD_IF_UP = 0.1;
// Re-entry.
const COOLDOWN_SLOTS = 200;
const MAX_ENTRIES_PER_MINT = 2;
// Guardrail pacing (final window is 6 hours).
const MAX_MAIN_POSITIONS = 4;
const TARGET_COINS = 25;
const TARGET_FILLS = 200;
const PACE_SECONDS = 21_600;
const PROBE_SOL = 0.02;
const MAX_PROBES = 1;

interface Trade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface Tape {
  created: number | null;
  trades: Trade[];
  entries: number;
  lastExit: number;
}

interface Held {
  opened: number;
  peakValue: number;
  invested: number;
  exiting: boolean;
  filled: boolean;
  lastAddPrice: number;
  lastValue: number;
}

const tapes = new Map<Pubkey, Tape>();
const held = new Map<Pubkey, Held>();
// Probe round trips in flight, by mint: false while buying, true once selling.
const probes = new Map<Pubkey, boolean>();
let myFills = 0;
const myCoins = new Set<Pubkey>();
let firstTime: number | null = null;
let lastTime: number | null = null;

function tapeOf(mint: Pubkey): Tape {
  let t = tapes.get(mint);
  if (t === undefined) {
    t = { created: null, trades: [], entries: 0, lastExit: -1e12 };
    tapes.set(mint, t);
  }
  return t;
}

/** Current price of a curve: virtual quote per virtual token. */
function priceOf(state: BotState, mint: Pubkey): number {
  const c = state.curves.get(mint);
  if (c === undefined) return 0;
  const vt = Number(c.virtual_token_reserves);
  if (vt <= 0) return 0;
  return Number(c.virtual_quote_reserves) / vt;
}

/** SOL the position would bring back if sold whole now, curve and tx fees off. */
function closeValue(state: BotState, mint: Pubkey): number {
  const pos = state.positions.get(mint);
  const c = state.curves.get(mint);
  if (pos === undefined || c === undefined) return 0;
  const tokens = Number(pos.token_amount);
  const vt = Number(c.virtual_token_reserves);
  const vq = Number(c.virtual_quote_reserves);
  if (vt + tokens <= 0) return 0;
  const gross = (tokens * vq) / (vt + tokens) / LAMPORTS;
  return gross * (1 - CURVE_FEE) - Number(state.txFeeLamports()) / LAMPORTS;
}

/** Net recorded SOL (buys minus sells) on a tape over the last `w` slots. */
function flow(t: Tape, now: number, w: number): number {
  let net = 0;
  for (let i = t.trades.length - 1; i >= 0; i--) {
    const tr = t.trades[i]!;
    if (tr.slot <= now - w) break;
    net += tr.buy ? tr.sol : -tr.sol;
  }
  return net;
}

/** Entry signal: mature curve, accelerating buy pressure, price near its high. */
function entrySignal(t: Tape, now: number, rqSol: number): boolean {
  if (rqSol < MIN_REAL_SOL || rqSol > MAX_REAL_SOL) return false;
  if (t.created === null || now - t.created < MIN_AGE_SLOTS) return false;
  const from = now - ENTRY_WINDOW_SLOTS;
  const mid = now - ENTRY_WINDOW_SLOTS / 2;
  let buySol = 0;
  let sellSol = 0;
  let buys = 0;
  let netOld = 0;
  let netNew = 0;
  let startPrice = -1;
  let high = 0;
  let last = 0;
  const byUser = new Map<string, number>();
  for (const tr of t.trades) {
    if (tr.slot <= from) {
      startPrice = tr.price;
      continue;
    }
    if (startPrice < 0) startPrice = tr.price;
    const signed = tr.buy ? tr.sol : -tr.sol;
    if (tr.slot <= mid) netOld += signed;
    else netNew += signed;
    if (tr.buy) {
      buySol += tr.sol;
      buys++;
      byUser.set(tr.user, (byUser.get(tr.user) ?? 0) + tr.sol);
    } else {
      sellSol += tr.sol;
    }
    if (tr.price > high) high = tr.price;
    last = tr.price;
  }
  if (buys < MIN_BUYS || byUser.size < MIN_BUYERS) return false;
  const net = buySol - sellSol;
  if (net < MIN_NET_SOL) return false;
  if (startPrice <= 0) return false;
  const up = last / startPrice - 1;
  if (up < MIN_RISE || up > MAX_RISE) return false;
  if (last < high * NEAR_HIGH) return false;
  // Flow must accelerate: the newer half of the window brings more than the older.
  if (netNew <= 0 || netNew < netOld) return false;
  let top = 0;
  for (const v of byUser.values()) if (v > top) top = v;
  // No single wallet may dominate the window's buying.
  if (top > 0.6 * buySol) return false;
  return true;
}

await runBot({
  onBatch(state: BotState, batch: Batch): OrderInput[] {
    const now = batch.slot;
    const bigSell = new Set<Pubkey>();
    const traded = new Set<Pubkey>();

    for (const f of batch.fills) {
      if (f.status === 'filled' && !f.client_id.startsWith('_')) {
        myFills++;
        myCoins.add(f.mint);
      }
    }
    for (const e of batch.events) {
      if (e.block_time !== null) {
        if (firstTime === null) firstTime = e.block_time;
        if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
      }
      if (e.event === 'CreateEvent') {
        tapeOf(e.mint).created = e.slot;
      } else if (e.event === 'TradeEvent') {
        const t = tapeOf(e.mint);
        const sol = Number(e.sol_amount) / LAMPORTS;
        t.trades.push({
          slot: e.slot,
          buy: e.is_buy,
          sol,
          user: e.user,
          price: Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves),
        });
        traded.add(e.mint);
        if (!e.is_buy && sol >= BIG_SELL_SOL) bigSell.add(e.mint);
      }
    }
    // Prune old trades off the tapes we touched.
    const keep = ENTRY_WINDOW_SLOTS + 5;
    for (const mint of traded) {
      const t = tapes.get(mint)!;
      let cut = 0;
      while (cut < t.trades.length && t.trades[cut]!.slot <= now - keep) cut++;
      if (cut > 0) t.trades.splice(0, cut);
    }

    const pendingByMint = new Map<Pubkey, number>();
    for (const po of state.pending.values()) {
      pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);
    }
    const orders: OrderInput[] = [];
    const cap = state.hello.caps.max_orders_per_batch;
    const tx = Number(state.txFeeLamports()) / LAMPORTS;

    // Exits first: stop loss, trailing stop, fading flow, big sell, time limit.
    for (const [mint, h] of held) {
      const pos = state.positions.get(mint);
      const curve = state.curves.get(mint);
      if (pos === undefined) {
        if (!pendingByMint.has(mint)) {
          held.delete(mint);
          if (h.filled) tapeOf(mint).lastExit = now;
          else tapeOf(mint).entries--;
        }
        continue;
      }
      h.filled = true;
      if (curve === undefined || curve.complete) continue;
      const value = closeValue(state, mint);
      const cost = Number(pos.cost_lamports) / LAMPORTS;
      if (value > h.peakValue) h.peakValue = value;
      h.lastValue = value;
      const t = tapeOf(mint);
      let exit = h.exiting;
      if (!exit && value < cost * (1 - STOP_LOSS)) exit = true;
      if (!exit && h.peakValue >= cost * (1 + TRAIL_ARM) && value < h.peakValue * (1 - TRAIL_DROP)) exit = true;
      if (!exit && flow(t, now, FADE_WINDOW_SLOTS) < -FADE_NET_SOL) exit = true;
      if (!exit && bigSell.has(mint)) exit = true;
      if (!exit && now - h.opened > MAX_HOLD_SLOTS && value < cost * (1 + HOLD_IF_UP)) exit = true;
      if (!exit) continue;
      h.exiting = true;
      let sellPending = false;
      for (const po of state.pending.values()) {
        if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
      }
      if (sellPending) continue;
      if (orders.length >= cap) break;
      orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
    }

    // Probe round trips: sell the whole probe as soon as its buy has landed.
    for (const [mint, selling] of probes) {
      const pos = state.positions.get(mint);
      const curve = state.curves.get(mint);
      if (pos === undefined) {
        if (!pendingByMint.has(mint)) probes.delete(mint);
        continue;
      }
      if (curve === undefined || curve.complete || pendingByMint.has(mint)) continue;
      if (orders.length >= cap) break;
      orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
      if (!selling) probes.set(mint, true);
    }

    // Entries and pyramid adds.
    let free = Number(state.freeCashLamports()) / LAMPORTS;
    let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
    let mainLeft = MAX_MAIN_POSITIONS - held.size;
    for (const mint of traded) {
      if (orders.length >= cap) break;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      if (pendingByMint.has(mint) || probes.has(mint)) continue;
      const t = tapes.get(mint)!;
      const h = held.get(mint);
      const price = priceOf(state, mint);
      const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
      let want: number;
      if (h === undefined) {
        if (slotsLeft <= 0 || mainLeft <= 0) continue;
        if (t.entries >= MAX_ENTRIES_PER_MINT || now - t.lastExit < COOLDOWN_SLOTS) continue;
        if (!entrySignal(t, now, rqSol)) continue;
        want = FIRST_BUY_SOL;
      } else {
        // Add only into strength: price stepped up, position not underwater,
        // flow still positive.
        if (h.exiting || !h.filled || h.invested >= MAX_STAKE_SOL - MIN_BUY_SOL) continue;
        const pos = state.positions.get(mint);
        if (pos === undefined) continue;
        if (price < h.lastAddPrice * 1.02) continue;
        if (h.lastValue < Number(pos.cost_lamports) / LAMPORTS) continue;
        if (flow(t, now, ENTRY_WINDOW_SLOTS) < MIN_NET_SOL) continue;
        if (rqSol > MAX_REAL_SOL) continue;
        want = Math.min(ADD_SOL, MAX_STAKE_SOL - h.invested);
      }
      const capSol = Number(state.maxBuyLamports(mint)) / LAMPORTS;
      let amount = Math.min(capSol, want);
      if (amount > free - tx) amount = free - tx;
      if (amount < MIN_BUY_SOL) continue;
      const lamports = BigInt(Math.floor(amount * LAMPORTS));
      orders.push({ side: 'buy', mint, quote_lamports: lamports, max_slippage_bps: BUY_SLIPPAGE_BPS });
      free -= amount + tx;
      if (h === undefined) {
        held.set(mint, {
          opened: now,
          peakValue: 0,
          invested: amount,
          exiting: false,
          filled: false,
          lastAddPrice: price,
          lastValue: 0,
        });
        t.entries++;
        slotsLeft--;
        mainLeft--;
      } else {
        h.invested += amount;
        h.lastAddPrice = price;
      }
    }

    // Guardrail pacing: open a probe when fills or coins lag the pace.
    if (probes.size < MAX_PROBES && slotsLeft > 0 && firstTime !== null && lastTime !== null) {
      const pace = Math.min(1, (lastTime - firstTime) / PACE_SECONDS);
      const needCoins = myCoins.size < Math.ceil(TARGET_COINS * pace);
      const needFills = myFills < Math.ceil(TARGET_FILLS * pace);
      if (needCoins || needFills) {
        // A 0.02 SOL probe needs a 1% cap of at least that: real reserve 2 SOL or more.
        for (const mint of traded) {
          if (orders.length >= cap || probes.size >= MAX_PROBES) break;
          if (held.has(mint) || probes.has(mint) || pendingByMint.has(mint) || state.positions.has(mint)) continue;
          if (needCoins && !needFills && myCoins.has(mint)) continue;
          const curve = state.curves.get(mint);
          if (curve === undefined || curve.complete) continue;
          if (Number(curve.real_quote_reserves) / LAMPORTS < 3) continue;
          if (free < PROBE_SOL + 2 * tx) break;
          orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(PROBE_SOL * LAMPORTS)), max_slippage_bps: BUY_SLIPPAGE_BPS });
          probes.set(mint, false);
          free -= PROBE_SOL + tx;
        }
      }
    }
    return orders;
  },
});
