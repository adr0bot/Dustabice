var config = {
    header:               { label: "— Skip burst —",                                   type: "noop" },
    skipCount:            { label: "Number of skips to perform",                       type: "number", value: 100 },
    intervalMs:           { label: "Delay between skips (ms)",                         type: "number", value: 250 },

    header2:              { label: "— Alerts —",                                       type: "noop" },
    target:               { label: "Target multiplier you care about",                 type: "multiplier", value: 2.0 },
    highMultiplier:       { label: "\"High multiplier\" alert threshold",              type: "multiplier", value: 10.0 },

    header3:              { label: "— Heuristic watch trigger (see comment; not a real prediction) —", type: "noop" },
    predictStreak:        { label: "Consecutive sub-target skips before the watch alert fires", type: "number", value: 8 },
    predictPauseMs:       { label: "Pause duration on watch alert (ms)",               type: "number", value: 5000 },

    header4:              { label: "— Backoff on rejection —",                         type: "noop" },
    backoffMs:            { label: "Extra delay added after each rejection (ms)",      type: "number", value: 1000 },
    maxBackoffMs:         { label: "Cap on delay after repeated rejections (ms)",       type: "number", value: 15000 },
    maxConsecutiveErrors: { label: "Abort after this many rejections in a row",         type: "number", value: 8 }
};

// -----------------------------------------------------------------------------
// SKIP BURST
//
// Calls this.skip() `skipCount` times, `intervalMs` apart. this.skip() consumes
// a nonce and returns the roll it would have been, but wagers nothing — it's
// the API's own tool for advancing through rolls without money at risk (e.g.
// the "watch" phase of a streak-hunter strategy, or fast-forwarding past a
// stretch of a revealed seed to a specific nonce). Skipping has no effect on
// EV or future odds: rolls are independent draws regardless of how many you
// skip past, so this doesn't create or reveal any edge either.
//
// Pacing: this does not attempt to find or duck under a rate limit. It paces
// itself at a fixed interval, and if a call gets rejected (which is how a
// server-side throttle would show up), it backs off additively and keeps
// retrying at the slower pace instead of hammering faster. If you're seeing
// rejections even at a conservative interval, that's the site telling you to
// slow down further — raise `intervalMs`, don't lower `backoffMs`. A hard
// breaker (`maxConsecutiveErrors`) stops the script rather than retrying
// forever.
//
// Alerts:
//   - Every skip logs its position in the queue (#done/skipCount).
//   - Any skipped roll >= `highMultiplier` gets an alert.
//   - Any skipped roll >= `target` gets a louder alert + log banner — you
//     told the script this multiplier matters, so a skip landing on/above it
//     is flagged harder than a generic high roll.
//   - "Predicted target roll, paused right before it": NOT IMPLEMENTED AS
//     ASKED, because it's impossible. The server seed that determines the
//     next roll is cryptographically committed (you only ever see its hash)
//     and stays secret until revealed — nobody, including the player, can
//     know a roll's outcome before it happens. What's implemented instead is
//     the honest, closest version: after `predictStreak` consecutive
//     sub-target skips, a loud "watch" alert fires and the script pauses for
//     `predictPauseMs` before the NEXT skip. This is a heuristic checkpoint
//     ("you set up to watch for a streak this long, here it is"), not a
//     prediction — the next roll's odds are exactly what they always are,
//     independent of the streak that preceded it. Treat it as a "pay
//     attention now" bell, not a signal with any edge.
// -----------------------------------------------------------------------------

const sleep = ms => new Promise(r => setTimeout(r, ms));

// notify() is documented as a bare global, but live testing shows it can
// throw "Can't find variable: notify" in some contexts — an uncaught
// ReferenceError there would crash the whole script mid-run. Route every
// alert through this helper so a missing notify() degrades to a log line
// instead of killing the script.
const alert = msg => {
    try { notify(msg); return; } catch (e) {}
    try { this.notify(msg); return; } catch (e) {}
    this.log(`[ALERT] ${msg}`);
};

let done = 0, errors = 0, consecutiveErrors = 0, subTargetStreak = 0;
let delay = config.intervalMs.value;

this.log(`start | ${config.skipCount.value} skips planned, ${config.intervalMs.value}ms apart | target=${config.target.value}x highAlert=${config.highMultiplier.value}x watchStreak=${config.predictStreak.value}`);

while (done < config.skipCount.value) {
    // --- heuristic watch checkpoint, fired BEFORE the skip that completes the streak ---
    if (subTargetStreak >= config.predictStreak.value) {
        alert(`WATCH: ${subTargetStreak} skips in a row under ${config.target.value}x — next roll's odds are unchanged, this is not a prediction`);
        this.log(`!!!!! WATCH TRIGGER: ${subTargetStreak} consecutive sub-target skips — pausing ${config.predictPauseMs.value}ms — odds on the next roll are exactly p=${(99 / config.target.value).toFixed(2)}%, same as always !!!!!`);
        await sleep(config.predictPauseMs.value);
        subTargetStreak = 0;
    }

    try {
        const result = await this.skip();
        done++;
        consecutiveErrors = 0;
        delay = config.intervalMs.value; // reset to base pace after a clean call

        this.log(`[#${done}/${config.skipCount.value}] skipped, would-have-rolled=${result.multiplier}x`);

        if (result.multiplier >= config.target.value) {
            subTargetStreak = 0;
            alert(`TARGET SKIPPED: roll was ${result.multiplier}x >= target ${config.target.value}x`);
            this.log(`***** TARGET HIT WHILE SKIPPING: ${result.multiplier}x (target ${config.target.value}x) at skip #${done} *****`);
        } else {
            subTargetStreak++;
        }

        if (result.multiplier >= config.highMultiplier.value) {
            alert(`High multiplier skipped: ${result.multiplier}x`);
            this.log(`*** HIGH MULTIPLIER SKIPPED: ${result.multiplier}x (threshold ${config.highMultiplier.value}x) at skip #${done} ***`);
        }
    } catch (err) {
        errors++; consecutiveErrors++;
        delay = Math.min(config.maxBackoffMs.value, delay + config.backoffMs.value);
        this.log(`skip rejected: ${err && err.message || err} — backing off to ${delay}ms`);
        if (consecutiveErrors >= config.maxConsecutiveErrors.value) {
            alert(`stopping: ${consecutiveErrors} consecutive skip rejections`);
            break;
        }
    }
    await sleep(delay);
}

this.log(`done | skipped=${done}/${config.skipCount.value} rejections=${errors}`);
await this.stop();
