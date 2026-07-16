# Bustadice Scripts

Auto-betting / auto-skipping scripts for the [Bustadice](https://bustadice.com) script
editor, plus the offline backtest harness used to validate them.

**Read this before you run it live:** Bustadice has a fixed 1% house edge on every bet,
independent of target, progression, or seed handling. **No script here — or anywhere —
changes that expected value.** What a script *can* do is change the shape of the outcome
distribution: how often you end up a little ahead, how often you end up wiped out, and
how fat the tails are. That's what this one does — it does not, and cannot, create an edge.

## Files

- `scripts/profit-vault-ladder.js` — the betting strategy, ready to paste into the
  Bustadice script editor.
- `scripts/skip-burst.js` — session/iteration/roll telemetry that tests and self-tunes
  around the "skips+1 ≈ target" hunch, wagering real money on it. See below.
- `tools/backtest.js` — zero-dependency Node harness (Monte Carlo, provably-fair seeded
  replay, or historical roll replay) used to validate the betting scripts before risking
  real money.
- `tools/pattern-test.js` — statistical test of the "skips+1 ≈ target" hunch directly
  against the real HMAC-SHA256 provably-fair algorithm, independent of any script's
  pacing. This is what actually answers whether the pattern has an edge.

## The strategy

**Profit-Vault Ladder** composes two layers over one balance, rather than reinventing a
single named system:

1. **Grind (flat, no progression).** Bet a fixed 1 bit at 1.98x (p = 50.0% win) forever.
   Flat betting has no progression geometry to bust — it just bleeds at the house edge
   as slowly and quietly as possible, which maximizes the number of bets (and therefore
   vault-sweep opportunities) a ~150-bit bankroll survives.
2. **Vault.** Every time the grind produces `vaultTrigger` bits of *new* realized profit
   strictly above the session's starting balance, `vaultSweepPct`% of exactly that new
   profit is earmarked into an in-memory vault. This is gated so it only ever pulls from
   profit already won — never from the original bankroll.
3. **Moonshot.** Once the vault holds at least 1 bit, it fires a single high-target shot
   (20x by default, p = 4.95%) sized off the vault (capped by `moonshotMaxBet`), win or
   lose, and the vault is spent down accordingly.

It's the same wallet the whole time — "vaulting" is bookkeeping, not a real firewall —
but it structurally bounds how much of any given profit run gets redeployed into a
high-variance shot instead of banked, and it guarantees the moonshot leg never sizes off
the original $10.

Composition-rule compliance (per the skill's strategy library): there is exactly one
progression-like mechanic (the vault-funded moonshot); the grind layer is flat/static so
this isn't "stacking progressions." Brakes (stop-loss, take-profit, error breaker) live
in the main loop outside both hooks.

### Sizing your config for a $10 bankroll

Bustadice balances are in bits (1 bit = 100 satoshis = 1e-6 BTC), and bits-per-dollar
depends on BTC's price when you deposit — there's no fixed $→bits constant. Formula:

```
bits = (USD / BTC_price_USD) × 1,000,000
```

Examples: at $50k/BTC, $10 ≈ 200 bits. At $100k/BTC, $10 ≈ 100 bits. At $150k/BTC,
$10 ≈ 67 bits. **The shipped defaults assume roughly a 150-bit bankroll** (`stopLoss:
130`, `takeProfit: 500`, sized as fractions of 150). Once you deposit, read your actual
bits balance in the Bustadice UI and scale every `balance`-type config value by
`yourBits / 150` before starting the script.

Bit-granularity caveat: with a $10-scale bankroll the minimum bet (1 bit = 100 sats) is
already a meaningful fraction of the whole stack — there's no room for finer fractional
sizing, so this script uses a fixed flat bet rather than "bet X% of balance."

## Ground truth (repeat, because it matters)

- Grind: target 1.98x → p = 0.99/1.98 = **50.0%** win per bet. No progression ⇒ no
  streak-driven bust geometry; risk is pure drift + variance, bounded by `stopLoss`.
- Moonshot: target 20x → p = 0.99/20 = **4.95%** win per shot.
- EV is exactly **−1% of wager** on every bet in both layers, always. Confirmed in the
  backtest below (realized edge tracks −1% within Monte Carlo noise).

## Backtest results (Monte Carlo, 3,000 sessions × up to 5,000 bets, 150-bit start)

```
node tools/backtest.js scripts/profit-vault-ladder.js --sessions 3000 --bets 5000 --balance 15000 --seed 42
```

| Metric | Profit-Vault Ladder | Flat baseline (1.98x, same brakes) |
|---|---|---|
| Final balance P5 | 19.28 bits | 19.30 bits |
| Final balance median | 94.06 bits | 100.00 bits |
| Final balance mean | 108.69 bits | 104.25 bits |
| Final balance P95 | 212.08 bits | 216.82 bits |
| Final balance P99 | **784.88 bits** | 264.34 bits |
| Final balance max seen | **987.58 bits** | 321.76 bits |
| Bust rate (<1 bit) | 0.0% | 0.0% |
| Max drawdown median / worst | 107.70 / **521.04** bits | 103.02 / 203.92 bits |
| Longest loss streak median / worst | 11 / 22 | 11 / 21 |
| Realized edge vs. theoretical −1% | −0.886% | −0.966% |
| Avg wager/bet · EV per 1,000 bets | 1.01 bits · **−10.05 bits** | — |

Read honestly: the vault ladder gives up a bit of *typical*-case outcome (median 94 vs.
100 bits) and takes on a much fatter worst-case drawdown (521 vs. 204 bits — the stop-loss
of 130 caps the loss on the grind, but the moonshot layer can spend vaulted profit that
was already above stop-loss territory, so the drawdown-from-peak metric runs past the
stop-loss number) in exchange for a real shot at the far right tail: the top 1% of
sessions end up **3–5x deeper into profit** than the flat baseline's top 1%, and the
observed max (987.58 bits, ~6.6x the 150-bit start) versus flat's max (321.76 bits, ~2.1x).
That is the entire trade this script makes — more lopsided, more lottery-shaped, same
−1%/bet drift underneath.

Stop-loss (`−130` bits, i.e. an 87% session drawdown cap) vs. take-profit (`+500` bits,
~3.3x) were set loosely on purpose to let the moonshot layer actually get chances to fire;
tighten `stopLoss` if an 87%-of-bankroll worst case is more than you want to carry for a
$10 stake — every 10 bits you tighten it by removes real upside too (gambler's-ruin
ratio: P(hit TP first) ≈ SL/(SL+TP) before edge drag).

## Risk sheet

- **The math no config changes:** −1% of every satoshi wagered, forever. Over 1,000 bets
  at the ~1-bit average size this script actually wagers, expected drift is **−10.05 bits**
  (~−6.7% of a 150-bit bankroll) from edge alone, before variance.
- **Bust:** 0.0% hit `<1 bit` in 3,000 simulated sessions — the stop-loss (130 bits, ~87%
  of a 150-bit stack) catches sessions well before true zero. If you want a harder floor,
  lower `stopLoss`.
- **The number that matters:** worst-case drawdown from peak was 521 bits (~3.5x the
  entire starting stack) in 3,000 sessions — that can only happen because the moonshot
  layer redeploys vaulted profit that had pushed the session balance well above start
  before giving it back. If that's not an acceptable swing for your $10, lower
  `moonshotMaxBet` and/or `vaultSweepPct` before going live.
- **This is not an edge.** It is a deliberate reshaping of a −1%/bet random walk toward
  "boring small loss most of the time, rare large multiple of the bankroll occasionally"
  instead of a smooth bleed. Treat the $10 as entertainment spend you're fully prepared
  to lose — because the math guarantees that's the modal long-run outcome of any
  strategy on this game.

## `skip-burst.js`

A plain frequency tracker: no wagering, no sessions, no iterations, no tuning search —
just `this.skip()` in a loop, logging every skip that clears `highMultiplier` or `target`,
and periodically reporting the real counts.

Every skip is checked against two thresholds and logged immediately when either hits,
along with the gap (in skips) since the last one of that type:
- `target` — the multiplier you're specifically tracking (e.g. 10x).
- `highMultiplier` — a separate, typically higher bar for "big roll" (e.g. 20x).

Every `reportEvery` skips (and once more at the end), it prints a summary line with:
- **Overall frequency** — hits ÷ total skips, for both target and high-roll, next to the
  theoretical rate (`p = 0.99 / multiplier`).
- **Short-run frequency** — the same ratio but only over the last `shortRunWindow` skips,
  so a hot or cold recent stretch is visible separately from the all-time rate.
- **Gap stats** — average/min/max skips between hits, next to the theoretical average gap
  (`1/p`).
- **Longest streak** of consecutive sub-target skips seen so far.

What this doesn't do: it doesn't interpret the numbers for you. Short streaks of hot or
cold windows are the expected texture of a random process on their own — that's stated
once, in the file's header comment, and the script otherwise just reports what actually
happened. Watch the short-run vs. long-run vs. theoretical numbers over enough skips (the
`tools/pattern-test.js` run used millions of trials to get a stable answer; a live session
will need a lot fewer to at least see whether the overall rate is converging toward theory
or staying detached from it) and draw your own conclusion from your own data.

**`notify()` note:** the API reference documents `notify()` as a bare global, but live
testing surfaced `ReferenceError: Can't find variable: notify` in practice — calling it
unguarded would crash the whole script mid-run. Every alert here goes through a small
`alert()` wrapper that tries `notify()`, then `this.notify()`, then falls back to
`this.log()`, so a missing `notify` degrades gracefully instead of killing the session.

Verified with a standalone throwaway harness (500 simulated skips, real HMAC-derived-style
random multipliers): gap tracking, streak tracking, short-run window, and summary output
all correct; `this.bet()` confirmed never called; finished in well under a second.

## Before going live

Run the on-site Backtesting tab as the final check — it enforces real `maxProfit`, real
bet rejection, and real latency that this offline harness only approximates. Start with
`stopLoss`/`takeProfit` tight, watch a session, then loosen once you trust the log output
matches this readout.
