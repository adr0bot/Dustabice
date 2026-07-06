#!/usr/bin/env node
/**
 * Empirical test of a specific claimed pattern in Bustadice's provably-fair
 * roll sequence: "for target T, after S = T-1 consecutive skips (misses),
 * betting the next 10-11 rolls shows an elevated win rate, especially every
 * 5th bet in that window."
 *
 * Uses the EXACT site derivation (same function as tools/backtest.js,
 * verified against github.com/bustadice/verifier): multiplier =
 * clamp(floor(99/(1-X)), 100, 1e8)/100 where X = first 52 bits of
 * HMAC-SHA256(serverSeed, `clientSeed|nonce`) / 2^52.
 *
 * Method: generate long roll sequences from many independent random seed
 * pairs (so this isn't an artifact of one server seed), scan for every
 * occurrence of S consecutive sub-target rolls, and record the outcome of
 * the following 11 rolls (offsets 0..10) at each occurrence. Compare each
 * offset's empirical win rate to the theoretical p = 0.99/T with a
 * Wilson score interval; a real effect would show as offsets (especially
 * 4 and 9, the "every 5th") sitting outside the CI of the baseline.
 *
 * node pattern-test.js [--target T] [--seeds N] [--nonces-per-seed N]
 */
"use strict";
const crypto = require("crypto");

const optNum = (n, d) => { const i = process.argv.indexOf("--" + n); return i > -1 ? Number(process.argv[i + 1]) : d; };
const TARGETS = (process.argv.includes("--target") ? [optNum("target", 2)] : [1.5, 2, 3, 5]);
const N_SEEDS = optNum("seeds", 200);
const NONCES_PER_SEED = optNum("nonces-per-seed", 200000);
const WINDOW = 11; // sequence[S] .. sequence[S+10]

function multiplierFromX(X) {
    return Math.max(100, Math.min(Math.floor(99 / (1 - X)), 100000000)) / 100;
}
function provablyFairMultiplier(serverSeed, clientSeed, nonce) {
    const hex = crypto.createHmac("sha256", serverSeed)
        .update(`${clientSeed}|${nonce}`)
        .digest("hex")
        .substring(0, 13);
    const X = parseInt(hex, 16) / Math.pow(2, 52);
    return multiplierFromX(X);
}

// Wilson score interval, 95%
function wilson(hits, n) {
    if (n === 0) return [NaN, NaN];
    const z = 1.959964;
    const p = hits / n;
    const denom = 1 + z * z / n;
    const center = p + z * z / (2 * n);
    const margin = z * Math.sqrt((p * (1 - p) + z * z / (4 * n)) / n);
    return [(center - margin) / denom, (center + margin) / denom];
}

for (const T of TARGETS) {
    const p = 0.99 / T;
    const S = Math.max(1, Math.round(T - 1));

    // per-offset hit/total counters across ALL occurrences of "S consecutive misses"
    const hits = new Array(WINDOW).fill(0);
    const totals = new Array(WINDOW).fill(0);
    let occurrences = 0;
    let totalRolls = 0, totalWins = 0; // unconditional baseline, sanity check

    for (let s = 0; s < N_SEEDS; s++) {
        const serverSeed = crypto.randomBytes(32).toString("hex");
        const clientSeed = crypto.randomBytes(8).toString("hex");
        const rolls = new Array(NONCES_PER_SEED);
        for (let n = 0; n < NONCES_PER_SEED; n++) {
            rolls[n] = provablyFairMultiplier(serverSeed, clientSeed, n);
            totalRolls++;
            if (rolls[n] >= T) totalWins++;
        }
        let missStreak = 0;
        for (let i = 0; i < rolls.length; i++) {
            if (missStreak === S) {
                occurrences++;
                for (let off = 0; off < WINDOW && i + off < rolls.length; off++) {
                    totals[off]++;
                    if (rolls[i + off] >= T) hits[off]++;
                }
            }
            missStreak = rolls[i] < T ? missStreak + 1 : 0;
        }
    }

    console.log(`\n=== target T=${T}x  (S=${S} consecutive sub-target rolls trigger, theoretical p=${(p * 100).toFixed(3)}%) ===`);
    console.log(`baseline (unconditional): ${totalWins}/${totalRolls} = ${(100 * totalWins / totalRolls).toFixed(3)}% (theory ${(p * 100).toFixed(3)}%)`);
    console.log(`trigger occurrences: ${occurrences}`);
    console.log(`offset  n        wins    win%      95% CI              "every 5th"?`);
    for (let off = 0; off < WINDOW; off++) {
        const [lo, hi] = wilson(hits[off], totals[off]);
        const flag = ((off + 1) % 5 === 0) ? "  <-- claimed hot spot" : "";
        console.log(
            `${String(off).padStart(6)}  ${String(totals[off]).padStart(7)}  ${String(hits[off]).padStart(6)}  ` +
            `${(100 * hits[off] / totals[off]).toFixed(3).padStart(6)}%  [${(100*lo).toFixed(3)}%, ${(100*hi).toFixed(3)}%]${flag}`
        );
    }
}
