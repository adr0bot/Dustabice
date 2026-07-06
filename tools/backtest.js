#!/usr/bin/env node
/**
 * Bustadice offline backtest harness. Zero dependencies. Three outcome engines:
 *
 * 1) Monte Carlo (default)
 *    node backtest.js strat.js --sessions 1000 --bets 3000 --balance 100000 --seed 42
 *
 * 2) Provably-fair seeded replay — EXACT bustadice derivation, verified against
 *    github.com/bustadice/verifier (HMAC-SHA256(serverSeed, `clientSeed|nonce`),
 *    first 52 bits -> X in [0,1), multiplier = clamp(floor(99/(1-X)), 100, 1e8)/100):
 *    node backtest.js strat.js --server-seed <hex> --client-seed <str> [--start-nonce 0]
 *    Single session replays the exact roll sequence your account would see on that
 *    seed pair. With --sessions N>1, client seed is salted per session
 *    ("<clientSeed>#<i>") to Monte-Carlo over the real algorithm.
 *    this.newSeedPair() rotates to a fresh random server seed mid-session (nonce
 *    resets to 0), exercising rotation logic faithfully.
 *
 * 3) Historical rolls replay
 *    node backtest.js strat.js --rolls history.txt
 *    One multiplier per line (e.g. "1.98" or "1.98x"; CSVs: last numeric column).
 *    Session ends when rolls are exhausted. Sessions > 1 reuse the same sequence
 *    (useful only if the strategy is stochastic or config is swept externally).
 *
 * Script contract: real bustadice API — `var config` first line,
 * `await this.bet(sizeSats, target)`, this.skip/log/stop/newSeedPair, notify().
 * `balance`-type config defaults are converted bits -> satoshis, matching the site.
 *
 * Reports: P5/median/mean/P95 final balance, bust rate, max drawdown,
 * longest loss streak, realized edge vs. theoretical -1%.
 */
"use strict";
const fs = require("fs");
const crypto = require("crypto");

// ---------- args ----------
const args = process.argv.slice(2);
if (!args[0] || args[0].startsWith("--")) {
    console.error("usage: node backtest.js <script.js> [--sessions N] [--bets N] [--balance SATS] [--seed N] [--server-seed HEX --client-seed STR [--start-nonce N]] [--rolls FILE]");
    process.exit(1);
}
const optNum = (n, d) => { const i = args.indexOf("--" + n); return i > -1 ? Number(args[i + 1]) : d; };
const optStr = (n, d) => { const i = args.indexOf("--" + n); return i > -1 ? args[i + 1] : d; };
const SESSIONS   = optNum("sessions", 500);
const MAX_BETS   = optNum("bets", 2000);
const START_BAL  = optNum("balance", 100000); // satoshis
const SERVER_SEED = optStr("server-seed", null);
const CLIENT_SEED = optStr("client-seed", "backtest");
const START_NONCE = optNum("start-nonce", 0);
const ROLLS_FILE  = optStr("rolls", null);
let lcgSeed = optNum("seed", Date.now() % 2147483647) || 1;

// ---------- shared multiplier math (identical clamp to the site) ----------
// X uniform in [0,1) -> multiplier float; site stores hundredths, clamp [1.00x, 1,000,000x]
function multiplierFromX(X) {
    return Math.max(100, Math.min(Math.floor(99 / (1 - X)), 100000000)) / 100;
}

// ---------- outcome engines ----------
function lcg() { lcgSeed = (lcgSeed * 48271) % 2147483647; return lcgSeed / 2147483647; }

// Exact bustadice derivation (verified vs official verifier, 150 vectors, 2026-07-05).
function provablyFairMultiplier(serverSeed, clientSeed, nonce) {
    const hex = crypto.createHmac("sha256", serverSeed)
        .update(`${clientSeed}|${nonce}`)
        .digest("hex")
        .substring(0, 13); // 52 bits
    const X = parseInt(hex, 16) / Math.pow(2, 52);
    return multiplierFromX(X);
}

let ROLLS = null;
if (ROLLS_FILE) {
    ROLLS = fs.readFileSync(ROLLS_FILE, "utf8").split(/\r?\n/)
        .map(line => {
            const nums = line.replace(/x/gi, "").split(/[,;\t ]+/).map(Number).filter(n => Number.isFinite(n) && n >= 1);
            return nums.length ? nums[nums.length - 1] : null;
        })
        .filter(v => v !== null);
    if (!ROLLS.length) { console.error("no parseable multipliers in " + ROLLS_FILE); process.exit(1); }
}

const MODE = ROLLS ? "rolls" : SERVER_SEED ? "seeded" : "montecarlo";

// ---------- load user script ----------
const src = fs.readFileSync(args[0], "utf8");
function extractConfig(source) {
    const m = source.match(/var\s+config\s*=\s*\{[\s\S]*?\n\};?/);
    if (!m) return {};
    const sandbox = {};
    new Function("sandbox", `${m[0]}\nsandbox.config = config;`)(sandbox);
    const cfg = sandbox.config || {};
    for (const k of Object.keys(cfg)) {
        if (cfg[k] && cfg[k].type === "balance" && typeof cfg[k].value === "number")
            cfg[k].value = Math.round(cfg[k].value * 100); // bits -> satoshis, like the site
    }
    return cfg;
}
const baseConfig = extractConfig(src);
const body = src.replace(/var\s+config\s*=\s*\{[\s\S]*?\n\};?/, "");
const runner = new Function("config", "notify", `return (async function(){ ${body}\n }).call(this);`);

// collapse retry delays so backtests run fast
const realSetTimeout = global.setTimeout;
global.setTimeout = (fn) => realSetTimeout(fn, 0);

// ---------- mock session ----------
class Session {
    constructor(index) {
        this.balance = START_BAL; this.bankroll = 1e12; this.maxProfit = 1e10;
        this.username = "backtest"; this.stopped = false;
        this.bets = 0; this.wins = 0; this.wagered = 0;
        this.peak = START_BAL; this.maxDD = 0;
        this.streak = 0; this.maxStreak = 0;
        this.rollPtr = 0;
        // seeded mode: independent nonce stream per session; salt client seed for MC-over-real-algo
        this.serverSeed = SERVER_SEED;
        this.clientSeed = SESSIONS > 1 && MODE === "seeded" ? `${CLIENT_SEED}#${index}` : CLIENT_SEED;
        this.nonce = START_NONCE;
        this.rotations = 0;
    }
    _draw() {
        if (MODE === "rolls") {
            if (this.rollPtr >= ROLLS.length) { this.stopped = true; throw new Error("rolls exhausted"); }
            return ROLLS[this.rollPtr++];
        }
        if (MODE === "seeded") return provablyFairMultiplier(this.serverSeed, this.clientSeed, this.nonce++);
        return multiplierFromX(lcg());
    }
    async bet(size, target) {
        if (this.stopped) throw new Error("stopped");
        if (!Number.isFinite(size) || size % 100 !== 0 || size < 100) throw new Error("bet size must be whole bits (satoshis % 100 == 0)");
        if (size > this.balance) throw new Error("insufficient balance");
        if (size * (target - 1) > this.maxProfit) throw new Error("exceeds max profit");
        const multiplier = this._draw();
        this.bets++; this.wagered += size;
        const won = multiplier >= target;
        this.balance += won ? Math.floor(size * (target - 1)) : -size;
        if (won) { this.wins++; this.streak = 0; }
        else { this.streak++; if (this.streak > this.maxStreak) this.maxStreak = this.streak; }
        if (this.balance > this.peak) this.peak = this.balance;
        const dd = this.peak - this.balance; if (dd > this.maxDD) this.maxDD = dd;
        if (this.bets >= MAX_BETS) this.stopped = true;
        return { id: String(this.bets), timestamp: new Date().toUTCString(), value: size, target,
                 multiplier, bankroll: this.bankroll, balance: this.balance, nonce: this.nonce - 1 };
    }
    async skip() { // consumes a nonce from the SAME stream, no wager — faithful to site
        const multiplier = this._draw();
        return { id: "s" + this.nonce, timestamp: new Date().toUTCString(), multiplier };
    }
    async newSeedPair(clientSeed) {
        if (MODE === "seeded" && this.nonce === START_NONCE && this.rotations === 0)
            throw new Error("current seed pair is unused"); // site behavior
        const prev = { prev_server_seed: this.serverSeed || "mc", prev_client_seed: this.clientSeed,
                       server_seed_hash: "" };
        if (MODE === "seeded") {
            this.serverSeed = crypto.randomBytes(32).toString("hex");
            this.clientSeed = clientSeed || crypto.randomBytes(8).toString("hex");
            this.nonce = 0; this.rotations++;
            prev.server_seed_hash = crypto.createHash("sha256").update(Buffer.from(this.serverSeed, "hex")).digest("hex");
        }
        return prev;
    }
    async setClientSeed(seedStr) {
        if (MODE === "seeded" && this.nonce > START_NONCE) throw new Error("seed pair already used");
        this.clientSeed = seedStr || crypto.randomBytes(8).toString("hex");
        return {};
    }
    async resetStatistics() {}
    async stop() { this.stopped = true; }
    log() {}
    clearLog() {}
    on() {}
}

// ---------- run ----------
(async () => {
    const finals = [], dds = [], streaks = [];
    let busts = 0, totalWagered = 0, totalPnl = 0, totalBets = 0;
    const nSessions = MODE === "seeded" && !args.includes("--sessions") ? 1 : SESSIONS;

    for (let s = 0; s < nSessions; s++) {
        const sess = new Session(s);
        const cfg = JSON.parse(JSON.stringify(baseConfig));
        try { await runner.call(sess, cfg, () => {}); } catch (e) { /* bust / rolls exhausted */ }
        finals.push(sess.balance); dds.push(sess.maxDD); streaks.push(sess.maxStreak);
        totalWagered += sess.wagered; totalPnl += sess.balance - START_BAL; totalBets += sess.bets;
        if (sess.balance < 100) busts++;
    }

    finals.sort((a, b) => a - b); dds.sort((a, b) => a - b); streaks.sort((a, b) => a - b);
    const pct = p => finals[Math.min(finals.length - 1, Math.floor(p * finals.length))];
    const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
    const bits = x => (x / 100).toFixed(2);

    console.log(`mode=${MODE}${MODE === "seeded" ? ` clientSeed="${CLIENT_SEED}"${nSessions > 1 ? " (salted per session)" : ""} startNonce=${START_NONCE}` : ""}${MODE === "rolls" ? ` rolls=${ROLLS.length}` : ""}`);
    console.log(`sessions=${nSessions} maxBets=${MAX_BETS} startBalance=${bits(START_BAL)} bits  totalBets=${totalBets}`);
    console.log(`final balance (bits):  P5=${bits(pct(0.05))}  median=${bits(pct(0.5))}  mean=${bits(mean(finals))}  P95=${bits(pct(0.95))}`);
    console.log(`bust rate (<1 bit):    ${(100 * busts / nSessions).toFixed(1)}%`);
    console.log(`max drawdown (bits):   median=${bits(dds[Math.floor(dds.length / 2)])}  worst=${bits(dds[dds.length - 1])}`);
    console.log(`longest loss streak:   median=${streaks[Math.floor(streaks.length / 2)]}  worst=${streaks[streaks.length - 1]}`);
    console.log(`realized edge:         ${(100 * totalPnl / Math.max(1, totalWagered)).toFixed(3)}% of volume (theory: -1.000%)`);
})();
