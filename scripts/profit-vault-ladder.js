var config = {
    header:         { label: "— Grind (flat, low variance) —",              type: "noop" },
    baseBet:        { label: "Grind base bet",                              type: "balance",   value: 1 },
    grindTarget:    { label: "Grind target multiplier",                     type: "multiplier", value: 1.98 },

    header2:        { label: "— Profit vault —",                            type: "noop" },
    vaultTrigger:   { label: "Sweep to vault after this much NEW profit (bits)", type: "balance", value: 5 },
    vaultSweepPct:  { label: "Percent of that new profit swept to vault",    type: "number",    value: 50 },

    header3:        { label: "— Moonshot (fired only with vaulted money) —", type: "noop" },
    moonshotTarget: { label: "Moonshot target multiplier",                  type: "multiplier", value: 20 },
    moonshotUsePct: { label: "Percent of vault risked per moonshot",        type: "number",    value: 100 },
    moonshotMaxBet: { label: "Hard cap on moonshot bet (bits)",             type: "balance",   value: 20 },

    header4:        { label: "— Risk controls —",                           type: "noop" },
    stopLoss:       { label: "Stop loss (bits, session)",                   type: "balance",   value: 130 },
    takeProfit:     { label: "Take profit (bits, session)",                 type: "balance",   value: 500 },
    rotateEvery:    { label: "Rotate seed every N bets (0=off)",            type: "number",    value: 0 }
};

// -----------------------------------------------------------------------------
// PROFIT-VAULT LADDER
//
// Two layers sharing one balance:
//   1) GRIND    - flat bet at a moderate target. No progression, so there is no
//                 streak-bust geometry; it bleeds at the -1% house edge as
//                 slowly and quietly as possible, which maximizes the number of
//                 bets (and therefore vault-sweep events) a small bankroll
//                 survives.
//   2) VAULT /  - every time the grind has produced `vaultTrigger` bits of NEW
//      MOONSHOT   realized profit (strictly above the session start balance,
//                 never eating into principal), a fraction of exactly that
//                 profit is earmarked and fired once at a high target. Win:
//                 proceeds land back in balance and extend the grind's
//                 runway. Loss: only the earmarked slice is gone.
//
// It is the same wallet either way - "vaulting" is bookkeeping, not a magic
// firewall - but it bounds how much of any given profit run gets redeployed
// into a high-variance shot instead of banked, and it structurally prevents
// the moonshot leg from ever sizing off the original $10.
//
// EV is -1% of wager on every single bet, both layers, no exceptions. This
// script reshapes the outcome distribution (slow grind + rare big multiplier)
// toward "more likely to end near or above start" and away from smooth bleed;
// it does not and cannot create positive expected value. See the risk sheet
// shipped alongside this script for the numbers.
// -----------------------------------------------------------------------------

const startBalance = this.balance;
const roundBet = sats => Math.max(100, Math.round(sats / 100) * 100);
const bits = s => (s / 100).toFixed(2);

// notify() is documented as a bare global, but live testing shows it can
// throw "Can't find variable: notify" in some contexts — an uncaught
// ReferenceError there would crash the whole script before this.stop() runs.
// Route every alert through this helper so a missing notify() degrades to a
// log line instead of killing the script mid-session.
const alert = msg => {
    try { notify(msg); return; } catch (e) {}
    try { this.notify(msg); return; } catch (e) {}
    this.log(`[ALERT] ${msg}`);
};

let bet = roundBet(config.baseBet.value);
let bets = 0, wins = 0, streak = 0;
let vault = 0;        // satoshis currently earmarked for a moonshot
let sweptTotal = 0;   // cumulative satoshis ever moved from "realized profit" into the vault
let consecutiveErrors = 0; // safety breaker: a persistently-rejecting bet must not retry forever

this.log(`start | balance=${bits(startBalance)} bits | grind p(win)=${(99 / config.grindTarget.value).toFixed(2)}% | moonshot p(win)=${(99 / config.moonshotTarget.value).toFixed(2)}%`);

while (true) {
    // --- brakes, checked before risking the next bet ---
    const pnl = this.balance - startBalance;
    if (pnl <= -config.stopLoss.value)   { alert(`STOP LOSS hit: ${bits(pnl)} bits`); break; }
    if (pnl >=  config.takeProfit.value) { alert(`TAKE PROFIT hit: +${bits(pnl)} bits`); break; }
    if (bet > this.balance)              { alert(`Balance can't cover next grind bet (${bits(bet)} bits)`); break; }

    // --- optional seed rotation (verification hygiene only; no EV effect) ---
    if (config.rotateEvery.value > 0 && bets > 0 && bets % config.rotateEvery.value === 0) {
        try { await this.newSeedPair(); this.log(`seed pair rotated @ bet ${bets}`); } catch (e) {}
    }

    // --- sweep unswept realized profit into the vault (pnl > 0 gated) ---
    const availableProfit = (this.balance - startBalance) - sweptTotal;
    if (availableProfit >= config.vaultTrigger.value) {
        const swept = roundBet(availableProfit * (config.vaultSweepPct.value / 100));
        vault += swept;
        sweptTotal += swept;
        this.log(`vault += ${bits(swept)} bits (vault=${bits(vault)} bits)`);
    }

    // --- fire a moonshot if the vault can afford at least the site minimum ---
    if (vault >= 100) {
        const shotSize = Math.min(
            roundBet(vault * (config.moonshotUsePct.value / 100)),
            roundBet(config.moonshotMaxBet.value),
            roundBet(this.balance)
        );
        let shot;
        try {
            shot = await this.bet(shotSize, config.moonshotTarget.value);
        } catch (err) {
            consecutiveErrors++;
            this.log(`moonshot rejected: ${err && err.message || err} — releasing vault back to grind`);
            vault = 0;
            if (consecutiveErrors >= 5) { alert(`stopping: ${consecutiveErrors} consecutive bet rejections`); break; }
            await new Promise(r => setTimeout(r, 2000));
            continue;
        }
        consecutiveErrors = 0;
        bets++;
        vault -= shotSize; // spent, win or lose
        const shotWon = shot.multiplier >= config.moonshotTarget.value;
        this.log(`[#${bets}] MOONSHOT ${shotWon ? "W" : "L"} x${shot.multiplier} bet=${bits(shotSize)} bal=${bits(shot.balance)} pnl=${bits(shot.balance - startBalance)}`);
        continue;
    }

    // --- grind bet (flat, no progression) ---
    let result;
    try {
        result = await this.bet(bet, config.grindTarget.value);
    } catch (err) {
        consecutiveErrors++;
        this.log(`bet rejected: ${err && err.message || err} — retrying in 2s`);
        if (consecutiveErrors >= 5) { alert(`stopping: ${consecutiveErrors} consecutive bet rejections`); break; }
        await new Promise(r => setTimeout(r, 2000));
        continue;
    }
    consecutiveErrors = 0;

    bets++;
    const won = result.multiplier >= config.grindTarget.value;
    if (won) { wins++; streak = 0; } else { streak++; }
    bet = roundBet(config.baseBet.value);

    if (bets % 25 === 0 || !won) {
        this.log(`[#${bets}] GRIND ${won ? "W" : "L"} x${result.multiplier} streak=${streak} bal=${bits(result.balance)} pnl=${bits(result.balance - startBalance)}`);
    }
}

this.log(`done | bets=${bets} wins=${wins} (${(100 * wins / Math.max(1, bets)).toFixed(1)}%) pnl=${bits(this.balance - startBalance)} bits`);
await this.stop();
