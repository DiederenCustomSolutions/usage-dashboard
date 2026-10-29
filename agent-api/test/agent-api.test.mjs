// node --test agent-api/test/agent-api.test.mjs
// Proves: every configured account is in /v1/usage,
// the token is required, and a database outage still answers JSON within 2 s.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { encrypt, decrypt, buildUsage, createStore, createServer, clientAllowed } from "../server.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(fs.readFileSync(path.join(here, "..", "config.example.json"), "utf8"));
const KEY = "test-pairing-key", TOKEN = "test-token-123";
const NOW = Date.parse("2026-10-29T10:00:00Z"); // 11:00 in Amsterdam = daytime

// Profile status as the extension writes it (shape taken from the live bin, values made up).
function profiles({ rob5h = 20, robWeek = 30, kb = 40, lxdg5h = 10, lxdgWeek = 10, claude = 30, seen = NOW - 60000 } = {}) {
    return {
        "pid-mufadq04-gpx8xl": { label: "Rob", syncStatus: {
            chatgpt: { lastSynced: seen, pctRemaining5h: 100 - rob5h, pctRemainingWeekly: 100 - robWeek, reset5hAbsoluteTs: NOW + 3600e3, resetWeeklyAbsoluteTs: NOW + 86400e3, source: "api" },
            claude: { lastSynced: seen, pctRemaining: 100 - claude, pctRemainingWeekly: 66, resetSessionAbsoluteTs: NOW + 7200e3, resetWeeklyAbsoluteTs: NOW + 5 * 86400e3, source: "api" } } },
        "pid-muqmwdvt-wifr8o": { label: "Kevin", syncStatus: {
            chatgpt: { lastSynced: seen, pctRemaining5h: null, pctRemainingWeekly: 100 - kb, resetWeeklyAbsoluteTs: NOW + 2 * 86400e3, source: "api" } } },
        "pid-muqnflpt-0g6nuh": { label: "Kevin – LXDG-DCS", syncStatus: {
            chatgpt: { lastSynced: seen, pctRemaining5h: 100 - lxdg5h, pctRemainingWeekly: 100 - lxdgWeek, reset5hAbsoluteTs: NOW + 600e3, resetWeeklyAbsoluteTs: NOW + 3 * 86400e3, source: "api" } } },
        "pid-muf9i094-12cwr6": { label: "Raimond", syncStatus: { claude: { lastSynced: seen, pctRemaining: 100, pctRemainingWeekly: 100 } } }
    };
}
const ids = u => u.accounts.map(a => a.id).sort().join(",");

test("crypto matches the dashboard scheme", () => {
    assert.equal(decrypt(encrypt("héllo {\"a\":1}", KEY), KEY), "héllo {\"a\":1}");
    // Fixed vector computed with the browser CryptoSync (btoa of XOR bytes).
    assert.equal(encrypt("ab", "k"), Buffer.from([0x61 ^ 0x6b, 0x62 ^ 0x6b]).toString("base64"));
});

test("all accounts present with the fixed fields", () => {
    const u = buildUsage(profiles(), config, { now: NOW });
    assert.equal(ids(u), "account1,account2,account3,claude");
    for (const a of u.accounts) {
        for (const f of ["id", "naam", "eigenaar", "dienst", "abonnement", "vijf_uur", "week", "bron", "laatst_gezien", "betrouwbaar"]) assert.ok(f in a, `${a.id}.${f}`);
        assert.equal(a.betrouwbaar, true);
    }
    const kb = u.accounts.find(a => a.id === "account2");
    assert.equal(kb.vijf_uur, null);
    assert.deepEqual(kb.week, { gebruikt_pct: 40, reset: new Date(NOW + 2 * 86400e3).toISOString() });
    assert.equal(u.accounts.find(a => a.id === "claude").vijf_uur.gebruikt_pct, 30);
    assert.ok(!JSON.stringify(u).includes("pid-"), "no internal profile ids");
});

test("measurement older than 15 min is not reliable", () => {
    const u = buildUsage(profiles({ seen: NOW - 16 * 60000 }), config, { now: NOW });
    assert.ok(u.accounts.every(a => a.betrouwbaar === false));
});

test("only loopback and tailnet clients", () => {
    const allowed = config.toegestaan;
    for (const ip of ["127.0.0.1", "::ffff:127.0.0.1", "::1", "100.70.217.45", "100.127.255.1"]) assert.equal(clientAllowed(ip, allowed), true, ip);
    for (const ip of ["192.168.1.20", "::ffff:10.0.0.5", "100.128.0.1", "fe80::1"]) assert.equal(clientAllowed(ip, allowed), false, ip);
});

// Integration: real HTTP server against a fake Firebase.
function fakeFirebase(state) {
    const s = http.createServer((req, res) => {
        if (state.down) { req.socket.destroy(); return; }
        if (req.url.includes("/status.json")) {
            const body = Object.fromEntries(Object.entries(state.profiles).map(([pid, p]) => [pid, { data: encrypt(JSON.stringify(p), KEY) }]));
            res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify(body));
        }
        if (req.url.includes("/meta.json") && req.method === "GET") {
            res.writeHead(200, { "content-type": "application/json", etag: "e1" }); return res.end(JSON.stringify({ data: encrypt(JSON.stringify(state.meta), KEY) }));
        }
        if (req.url.includes("/meta.json") && req.method === "PUT") {
            let b = ""; req.on("data", c => (b += c)); req.on("end", () => { state.meta = JSON.parse(decrypt(JSON.parse(b).data, KEY)); state.puts++; res.end("{}"); });
            return;
        }
        res.writeHead(404); res.end("null");
    });
    return new Promise(r => s.listen(0, "127.0.0.1", () => r(s)));
}
const listen = s => new Promise(r => s.listen(0, "127.0.0.1", () => r(s.address().port)));

test("HTTP: token, JSON, refresh trigger, outage fallback", async () => {
    const fb = { profiles: profiles({ seen: NOW - 10 * 60000 }), meta: { schema: 2, dashboardConfig: { x: 1 } }, puts: 0, down: false };
    const fbServer = await fakeFirebase(fb);
    let now = NOW;
    const cfg = { ...config, cache_s: 0, leestijd_ms: 500 };
    const store = createStore(cfg, { dbUrl: `http://127.0.0.1:${fbServer.address().port}`, binId: "bin", pairingKey: KEY });
    const server = createServer({ config: cfg, token: TOKEN, store, clock: () => now });
    const port = await listen(server);
    const get = (p, tok = TOKEN) => fetch(`http://127.0.0.1:${port}${p}`, { headers: tok ? { Authorization: `Bearer ${tok}` } : {} });
    try {
        assert.equal((await get("/v1/usage", null)).status, 401);
        assert.equal((await get("/v1/usage", "wrong")).status, 401);

        const r = await get("/v1/usage");
        assert.equal(r.status, 200);
        const u = await r.json();
        assert.equal(ids(u), "account1,account2,account3,claude");
        assert.ok(u.accounts.every(a => a.betrouwbaar));
        // Data 10 min old > 5 min: the request asked the Chromes for a refresh, meta kept intact.
        await new Promise(res => setTimeout(res, 100));
        assert.equal(fb.puts, 1);
        assert.equal(fb.meta.refreshRequested, true);
        assert.deepEqual(fb.meta.dashboardConfig, { x: 1 });

        assert.equal((await get("/v1/advies?soort=zwaar")).status, 404);

        // Database down: last values, betrouwbaar false, still JSON, within 2 s.
        fb.down = true; now += 1000;
        const t0 = Date.now();
        const down = await get("/v1/usage");
        assert.ok(Date.now() - t0 < 2000);
        const d = await down.json();
        assert.equal(ids(d), "account1,account2,account3,claude");
        assert.ok(d.accounts.every(a => a.betrouwbaar === false));
        assert.match(d.fout, /laatste bekende waarden/);
    } finally {
        server.close(); fbServer.close();
    }
});
