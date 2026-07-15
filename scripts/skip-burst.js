var config = {
    header:               { label: "— Hunch: (skips+1) ≈ target —",                    type: "noop" },
    target:               { label: "Target multiplier (T)",                           type: "multiplier", value: 10 },
    startSkips:           { label: "Iteration-1 skip count (0 = auto, T-1)",           type: "number", value: 0 },
    betSize:              { label: "Wager size per iteration (bits)",                  type: "balance", value: 1 },

    header2:              { label: "— Search tuning —",                                type: "noop" },
    tuneStep:              { label: "Skip-count search step after a loss",              type: "number", value: 1 },
    maxSkipsPerIteration: { label: "Hard cap on skips in one iteration",               type: "number", value: 50 },

    header3:              { label: "— Session budget & risk (real money from here) —", type: "noop" },
    maxIterations:        { label: "Max iterations this session (0 = unlimited)",      type: "number", value: 200 },
    stopLoss:             { label: "Stop loss (bits, session)",                        type: "balance", value: 100 },
    takeProfit:           { label: "Take profit (bits, session)",                      type: "balance", value: 300 },

    header4:              { label: "— Alerts —",                                       type: "noop" },
    highMultiplier:       { label: "\"High multiplier\" alert threshold",              type: "multiplier", value: 20 },

    header5:              { label: "— Pacing / backoff —",                             type: "noop" },
    intervalMs:           { label: "Delay between actions (ms)",                       type: "number", value: 250 },
    backoffMs:            { label: "Extra delay added per rejection (ms)",             type: "number", value: 1000 },
    maxBackoffMs:         { label: "Cap on backoff delay (ms)",                        type: "number", value: 15000 },
    maxConsecutiveErrors: { label: "Abort after this many rejections in a row",        type: "number", value: 8 },

    header6:              { label: "— Debug —",                                        type: "noop" },
    resetCounters:        { label: "Reset session/global counters before this run",    type: "checkbox", value: false }
};

// -----------------------------------------------------------------------------
// SKIP BURST — session / iteration / roll hunch tuner
//
// Data model:
//   SESSION   one script run, from this Start press to the next Start press.
//   ITERATION one skip-then-wager cycle within a session: skip `S` times, then
//             place one real wager at `target`.
//   ROLL      one this.skip() or this.bet() call — the atomic unit. Every roll
//             is tagged with its full address: session, iteration, roll-in-
//             session, and roll-globally-ever.
//
// Indexing:
//   sessionIndex        persists across sessions (survives a restart), read
//                        from localStorage and incremented on every Start.
//   iterationIndex       resets to 0 at the start of every session.
//   rollIndexInSession    resets to 0 at the start of every session, increments
//                        across iterations within that session.
//   globalRollIndex      persists across sessions, never resets.
// Every roll is logged as `[S<session> I<iteration> R<rollInSession>
// G<globalRoll>] {...attributes}` so any single event can be located exactly.
//
// Persistence: there's no documented cross-run storage API for Bustadice
// scripts, so this uses the browser's localStorage (the script runs as plain
// page JS, so it should be reachable) guarded by try/catch. If it's not
// available in your context, session/global counters silently reset to
// 1/0 every run instead of surviving restarts — you'll get one WARNING log
// line about it, everything else still works.
//
// The hunch being tested: at the target T, betting after S = T-1 skips
// (i.e. "skips+1 ≈ T") wins more than baseline. Iteration 1 of every session
// starts at that anchor and logs its outcome as the ONSET delta. On a loss,
// later iterations probe outward from the anchor in a +1,-1,+2,-2,... pattern
// (step size = `tuneStep`) looking for a skip count that actually works; a
// win re-anchors the search there and the next iteration retests it for
// reproducibility. This is a hill-search over your hypothesis, not a proven
// exploit — a large real-seed test of exactly the T=10/S=9 case earlier
// showed 9.928% observed vs. 9.898-9.900% theoretical (well inside the
// confidence interval, i.e. no detectable edge). Build the search anyway,
// look at your own data; the telemetry here is honest either way.
//
// Because this version places real bets (unlike the skip-only predecessor),
// it carries the mandatory stop-loss/take-profit brakes, checked before every
// wager (skips cost nothing so they aren't gated on balance).
// -----------------------------------------------------------------------------

const sleep = ms => new Promise(r => setTimeout(r, ms));
const roundBet = sats => Math.max(100, Math.round(sats / 100) * 100);
const bits = s => (s / 100).toFixed(2);

// notify() is documented as a bare global, but live testing shows it can
// throw "Can't find variable: notify" in some contexts — an uncaught
// ReferenceError there would crash the whole script mid-run. Route every
// alert through this helper so a missing notify() degrades to a log line.
const alert = msg => {
    try { notify(msg); return; } catch (e) {}
    try { this.notify(msg); return; } catch (e) {}
    this.log(`[ALERT] ${msg}`);
};

// --- cross-session persistence (best-effort) ---
const STORAGE_KEY = "bustadice_skipburst_state_v2";
let persistenceOk = true;
const loadPersisted = () => {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        return raw ? JSON.parse(raw) : null;
    } catch (e) { persistenceOk = false; return null; }
};
const savePersisted = state => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) { persistenceOk = false; }
};

let prior = config.resetCounters.value ? null : loadPersisted();
if (!prior) prior = { sessionIndex: 0, globalRollIndex: 0 };
const sessionIndex = prior.sessionIndex + 1;
let globalRollIndex = prior.globalRollIndex;
savePersisted({ sessionIndex, globalRollIndex }); // reserve this session's index immediately
if (!persistenceOk) {
    this.log(`WARNING: localStorage unavailable — session/global counters will NOT persist across restarts; every run starts at session 1 / global 0.`);
}

// --- session-local state ---
const sessionStartBalance = this.balance;
let iterationIndex = 0;
let rollIndexInSession = 0;
let errors = 0, consecutiveErrors = 0;
let delay = config.intervalMs.value;

const wager = roundBet(config.betSize.value);
const baseSkipsInit = config.startSkips.value > 0
    ? Math.round(config.startSkips.value)
    : Math.max(0, Math.round(config.target.value - 1));

let baseSkip = baseSkipsInit;   // current search anchor
let probeIndex = 0;             // 0 = testing the anchor itself
const probeOffset = k => {
    if (k === 0) return 0;
    const n = Math.ceil(k / 2);
    const sign = (k % 2 === 1) ? 1 : -1;
    return sign * n * config.tuneStep.value;
};
const clampSkips = s => Math.max(0, Math.min(config.maxSkipsPerIteration.value, s));
let skipsNext = clampSkips(baseSkip + probeOffset(probeIndex));

const recordRoll = () => {
    rollIndexInSession++;
    globalRollIndex++;
    savePersisted({ sessionIndex, globalRollIndex });
};

// retries a skip/bet call with backoff; throws only after maxConsecutiveErrors in a row
const attempt = async (actionFn, label) => {
    for (;;) {
        try {
            const res = await actionFn();
            consecutiveErrors = 0;
            delay = config.intervalMs.value;
            return res;
        } catch (err) {
            errors++; consecutiveErrors++;
            delay = Math.min(config.maxBackoffMs.value, delay + config.backoffMs.value);
            this.log(`${label} rejected: ${err && err.message || err} — backing off to ${delay}ms`);
            if (consecutiveErrors >= config.maxConsecutiveErrors.value) {
                alert(`stopping: ${consecutiveErrors} consecutive rejections`);
                throw err;
            }
            await sleep(delay);
        }
    }
};

this.log(`[SESSION ${sessionIndex} START] target=${config.target.value}x anchorSkips=${baseSkip} wager=${bits(wager)} bits balance=${bits(sessionStartBalance)} bits globalRollsSoFar=${globalRollIndex}`);

sessionLoop:
while (true) {
    const pnl = this.balance - sessionStartBalance;
    if (pnl <= -config.stopLoss.value)   { alert(`STOP LOSS hit: ${bits(pnl)} bits`); break; }
    if (pnl >=  config.takeProfit.value) { alert(`TAKE PROFIT hit: +${bits(pnl)} bits`); break; }
    if (config.maxIterations.value > 0 && iterationIndex >= config.maxIterations.value) {
        this.log(`iteration budget (${config.maxIterations.value}) reached`); break;
    }
    if (wager > this.balance) { alert(`Balance can't cover next wager (${bits(wager)} bits)`); break; }

    iterationIndex++;
    const S = skipsNext;

    // --- skip phase (no money) ---
    for (let k = 0; k < S; k++) {
        let skipRes;
        try { skipRes = await attempt(() => this.skip(), "skip"); }
        catch (e) { break sessionLoop; }
        recordRoll();
        this.log(`[S${sessionIndex} I${iterationIndex} R${rollIndexInSession} G${globalRollIndex}] ${JSON.stringify({ type: "skip", multiplier: skipRes.multiplier })}`);
        if (skipRes.multiplier >= config.target.value) {
            alert(`iteration ${iterationIndex}: skip #${k + 1} would have hit target ${config.target.value}x (rolled ${skipRes.multiplier}x)`);
        }
        if (skipRes.multiplier >= config.highMultiplier.value) {
            alert(`high multiplier skipped: ${skipRes.multiplier}x`);
        }
        await sleep(delay);
    }

    // brakes again right before risking money, in case a long skip phase changed balance via other tabs/activity
    const pnl2 = this.balance - sessionStartBalance;
    if (pnl2 <= -config.stopLoss.value)   { alert(`STOP LOSS hit: ${bits(pnl2)} bits`); break; }
    if (pnl2 >=  config.takeProfit.value) { alert(`TAKE PROFIT hit: +${bits(pnl2)} bits`); break; }
    if (wager > this.balance) { alert(`Balance can't cover wager (${bits(wager)} bits)`); break; }

    // --- wager phase (real money) ---
    let betRes;
    try { betRes = await attempt(() => this.bet(wager, config.target.value), "bet"); }
    catch (e) { break; }
    recordRoll();

    const won = betRes.multiplier >= config.target.value;
    const delta = (S + 1) - config.target.value;
    this.log(`[S${sessionIndex} I${iterationIndex} R${rollIndexInSession} G${globalRollIndex}] ${JSON.stringify({
        type: "wager", skips: S, betSize: wager, target: config.target.value,
        multiplier: betRes.multiplier, won, delta, balance: betRes.balance,
        pnl: betRes.balance - sessionStartBalance
    })}`);

    if (iterationIndex === 1) {
        this.log(`[S${sessionIndex} ONSET] skips+1=${S + 1} target=${config.target.value} delta=${delta} won=${won}`);
    }
    if (betRes.multiplier >= config.highMultiplier.value) {
        alert(`high multiplier on wager: ${betRes.multiplier}x`);
    }

    // --- tuning: re-anchor on a win, probe outward on a loss ---
    if (won) {
        baseSkip = S;
        probeIndex = 0;
        this.log(`[S${sessionIndex} I${iterationIndex}] WIN — anchoring search on skips=${S}, retesting next iteration for reproducibility`);
    } else {
        probeIndex++;
    }
    skipsNext = clampSkips(baseSkip + probeOffset(probeIndex));

    await sleep(delay);
}

this.log(`[SESSION ${sessionIndex} SUMMARY] iterations=${iterationIndex} rollsThisSession=${rollIndexInSession} globalRollsAllTime=${globalRollIndex} rejections=${errors} finalBalance=${bits(this.balance)} bits pnl=${bits(this.balance - sessionStartBalance)} bits`);
await this.stop();
