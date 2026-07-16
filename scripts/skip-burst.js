var config = {
    header:               { label: "— What to watch for —",                 type: "noop" },
    target:               { label: "Target multiplier to track",           type: "multiplier", value: 10 },
    highMultiplier:       { label: "\"High roll\" threshold to track",     type: "multiplier", value: 20 },

    header2:              { label: "— Run —",                              type: "noop" },
    maxSkips:             { label: "Total skips to run (0 = unlimited)",   type: "number", value: 0 },
    intervalMs:           { label: "Delay between skips (ms)",             type: "number", value: 250 },
    reportEvery:          { label: "Print a frequency summary every N skips", type: "number", value: 50 },
    shortRunWindow:       { label: "Window size for short-run frequency",  type: "number", value: 100 },

    header3:              { label: "— Backoff on rejection —",             type: "noop" },
    backoffMs:            { label: "Extra delay added per rejection (ms)", type: "number", value: 1000 },
    maxBackoffMs:         { label: "Cap on backoff delay (ms)",            type: "number", value: 15000 },
    maxConsecutiveErrors: { label: "Abort after this many rejections in a row", type: "number", value: 8 }
};

// -----------------------------------------------------------------------------
// SKIP TRACKER
//
// No wagering, no sessions, no tuning search — just this.skip() in a loop,
// logging every skipped roll that clears `highMultiplier` or `target`, and
// periodically reporting the actual frequencies (overall and in a recent
// short-run window) so you can compare them against theory, and against
// whatever pattern your own manual tracking has shown you.
//
// What "frequency" means here: p = 0.99 / multiplier is each roll's real,
// fixed win probability — independent of everything that came before it.
// Over any given window, the OBSERVED rate will wander above and below that
// number by chance alone; short streaks of both hot and cold windows are the
// expected texture of a random process, not evidence on their own. The
// numbers below are exactly what they are, though — real counts and real
// gaps, not a claim about what they mean. Watch the short-run vs. long-run
// vs. theoretical numbers over enough skips and draw your own conclusion.
// -----------------------------------------------------------------------------

const sleep = ms => new Promise(r => setTimeout(r, ms));

const alert = msg => {
    try { notify(msg); return; } catch (e) {}
    try { this.notify(msg); return; } catch (e) {}
    this.log(`[ALERT] ${msg}`);
};

const T = config.target.value;
const H = config.highMultiplier.value;
const pTarget = 99 / T;   // percent
const pHigh = 99 / H;     // percent

let totalSkips = 0, errors = 0, consecutiveErrors = 0, delay = config.intervalMs.value;
let lastSummaryAt = 0;

let targetHits = 0, lastTargetHitAt = 0;
let targetGapCount = 0, targetGapSum = 0, targetGapMin = Infinity, targetGapMax = 0;

let highHits = 0, lastHighHitAt = 0;
let highGapCount = 0, highGapSum = 0, highGapMin = Infinity, highGapMax = 0;

let subTargetStreak = 0, longestSubTargetStreak = 0;

const window_ = []; // recent booleans: did this skip clear target?

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

const printSummary = () => {
    const overallTargetPct = 100 * targetHits / totalSkips;
    const overallHighPct = 100 * highHits / totalSkips;
    const shortRunPct = 100 * window_.reduce((a, b) => a + b, 0) / window_.length;
    const avgTargetGap = targetGapCount ? (targetGapSum / targetGapCount).toFixed(1) : "n/a";
    const avgHighGap = highGapCount ? (highGapSum / highGapCount).toFixed(1) : "n/a";
    this.log(
        `[SUMMARY @ ${totalSkips} skips] ` +
        `target(${T}x): hits=${targetHits} overall=${overallTargetPct.toFixed(2)}% ` +
        `shortRun(${window_.length})=${shortRunPct.toFixed(2)}% theory=${pTarget.toFixed(2)}% ` +
        `avgGap=${avgTargetGap} (theory ${(100 / pTarget).toFixed(1)}) minGap=${targetGapMin === Infinity ? "n/a" : targetGapMin} maxGap=${targetGapMax} ` +
        `longestMissStreak=${longestSubTargetStreak} | ` +
        `high(${H}x): hits=${highHits} overall=${overallHighPct.toFixed(2)}% theory=${pHigh.toFixed(2)}% avgGap=${avgHighGap}`
    );
};

this.log(`start | tracking target=${T}x (theory ${pTarget.toFixed(2)}%) and high=${H}x (theory ${pHigh.toFixed(2)}%) | window=${config.shortRunWindow.value}`);

while (config.maxSkips.value === 0 || totalSkips < config.maxSkips.value) {
    let result;
    try { result = await attempt(() => this.skip(), "skip"); }
    catch (e) { break; }

    totalSkips++;
    const m = result.multiplier;
    const hitTarget = m >= T;
    const hitHigh = m >= H;

    if (hitTarget) {
        targetHits++;
        const gap = totalSkips - lastTargetHitAt;
        if (lastTargetHitAt > 0) {
            targetGapCount++; targetGapSum += gap;
            if (gap < targetGapMin) targetGapMin = gap;
            if (gap > targetGapMax) targetGapMax = gap;
        }
        lastTargetHitAt = totalSkips;
        if (subTargetStreak > longestSubTargetStreak) longestSubTargetStreak = subTargetStreak;
        subTargetStreak = 0;
        this.log(`[#${totalSkips}] TARGET HIT x${m} (skipped) gap=${gap}`);
        alert(`Target hit while skipping: x${m} (target ${T}x), gap=${gap} skips since last`);
    } else {
        subTargetStreak++;
    }

    if (hitHigh) {
        highHits++;
        const gap = totalSkips - lastHighHitAt;
        if (lastHighHitAt > 0) {
            highGapCount++; highGapSum += gap;
            if (gap < highGapMin) highGapMin = gap;
            if (gap > highGapMax) highGapMax = gap;
        }
        lastHighHitAt = totalSkips;
        this.log(`[#${totalSkips}] HIGH ROLL x${m} (skipped) gap=${gap}`);
        alert(`High roll skipped: x${m} (threshold ${H}x)`);
    }

    window_.push(hitTarget ? 1 : 0);
    if (window_.length > config.shortRunWindow.value) window_.shift();

    if (totalSkips % config.reportEvery.value === 0) { printSummary(); lastSummaryAt = totalSkips; }

    await sleep(delay);
}

if (subTargetStreak > longestSubTargetStreak) longestSubTargetStreak = subTargetStreak;
if (totalSkips !== lastSummaryAt) printSummary();
this.log(`done | totalSkips=${totalSkips} rejections=${errors}`);
await this.stop();
