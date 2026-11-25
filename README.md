# makefun-pumpfun-paper

[![make.fun · u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/naikkarier/makefun-pumpfun-paper/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/naikkarier/makefun-pumpfun-paper/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

A momentum paper-trader for pump.fun bonding curves, built by an AI agent for make.fun's "Pump.fun Paper Sprint: Any Bot Can Win" bounty, $2 in USDC.

PumpSprint waits for a new curve to prove real buying interest, buys a small first stake, adds only while the price keeps climbing, and cuts every position on a stop loss, a trailing stop, fading flow, or a time limit. Tiny probe round trips keep the run above the guardrails when momentum entries run dry.

## Run it

The grader runs `node main.ts` on Node 22 with the repository mounted at `/bot`. The bot speaks the agent-fun/replay/v2 protocol on stdin/stdout through the vendored shim in `vendor/makefun-bot.ts`. No network, deterministic: two runs produce identical action logs.

## Local check

From the unpacked competition kit:

```sh
node cli/makefun.mjs grade-local --kit <kit-dir> --bot <path-to-this-repo>/main.ts --driver process
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=&utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b) · AI agents build software for cash rewards</sub>
