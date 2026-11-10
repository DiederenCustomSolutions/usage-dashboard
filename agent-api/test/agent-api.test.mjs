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

test("repair check: every account must be measured after the moment asked for", async () => {
    const { allMeasuredSince } = await import("../herstel-check.mjs");
    const seen = iso => ({ laatst_gezien: iso });
    const since = Date.parse("2026-11-04T11:44:00Z");
    assert.equal(allMeasuredSince([seen("2026-11-04T11:44:10Z"), seen("2026-11-04T11:45:00Z")], since), true);
    assert.equal(allMeasuredSince([seen("2026-11-04T11:44:10Z"), seen("2026-11-04T09:55:00Z")], since), false);
    assert.equal(allMeasuredSince([seen("2026-11-04T11:44:10Z"), seen(null)], since), false);
    assert.equal(allMeasuredSince([], since), false);
});

// ---- Login links on request (v0.34.0) ----
const PID_RAIMOND = "pid-muf9i094-12cwr6";
function fakeMetaDb(state) {
    const sse = new Set();
    const s = http.createServer((req, res) => {
        if (!req.url.includes("/meta.json")) { res.writeHead(404); return res.end("null"); }
        if (req.method === "GET" && req.headers.accept === "text/event-stream") {
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.write("event: put\ndata: {\"path\":\"/\",\"data\":null}\n\n");
            sse.add(res); req.on("close", () => sse.delete(res)); return;
        }
        if (req.method === "GET") {
            res.writeHead(200, { "content-type": "application/json", etag: "e" + state.puts }); return res.end(JSON.stringify({ data: encrypt(JSON.stringify(state.meta), KEY) }));
        }
        let b = ""; req.on("data", c => (b += c)); req.on("end", () => {
            if (state.conflictOnce) { state.conflictOnce = false; res.writeHead(412); return res.end("{}"); }
            state.meta = JSON.parse(decrypt(JSON.parse(b).data, KEY)); state.puts++;
            for (const c of sse) c.write("event: put\ndata: {}\n\n");   // own write comes back on the stream
            res.end("{}");
        });
    });
    return new Promise(r => s.listen(0, "127.0.0.1", () => r({ server: s, sse })));
}
const waitFor = async (fn, ms = 2000) => { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) throw new Error("timeout"); await new Promise(r => setTimeout(r, 20)); } };

test("login link: request becomes an encrypted link, request removed, rest of meta kept", async () => {
    const { createLoginService, LINK_RE } = await import("../inlog.mjs");
    const NOW2 = Date.now();
    const st = { puts: 0, meta: { schema: 2, dashboardConfig: { x: 1 }, loginRequests: { [PID_RAIMOND]: { at: NOW2 - 1000 }, "pid-unknown": { at: NOW2 - 1000 }, "pid-old": { at: NOW2 - 3600e3 } } } };
    const { server } = await fakeMetaDb(st);
    const calls = [];
    const run = async (name, min) => { calls.push([name, min]); return "http://agents.tailnet.ts.net:8792/" + "a".repeat(48); };
    const svc = createLoginService(config, { dbUrl: `http://127.0.0.1:${server.address().port}`, binId: "bin", pairingKey: KEY }, { run });
    try {
        st.conflictOnce = true;   // first write loses the ETag race: must retry from a fresh read
        await svc.check();
        assert.deepEqual(calls, [["raimond", 30]]);
        const l = st.meta.loginLinks[PID_RAIMOND];
        assert.match(l.url, LINK_RE);
        assert.equal(l.until - l.at, 30 * 60000);
        assert.match(st.meta.loginLinks["pid-unknown"].error, /no measuring Chrome/);
        assert.equal(st.meta.loginLinks["pid-old"], undefined);
        assert.deepEqual(st.meta.loginRequests, {});
        assert.deepEqual(st.meta.dashboardConfig, { x: 1 });
    } finally { server.close(); }
});

test("login link: failing script gives an error entry, never a half link", async () => {
    const { createLoginService, runInlogLink } = await import("../inlog.mjs");
    const st = { puts: 0, meta: { schema: 2, loginRequests: { [PID_RAIMOND]: { at: Date.now() } } } };
    const { server } = await fakeMetaDb(st);
    const svc = createLoginService(config, { dbUrl: `http://127.0.0.1:${server.address().port}`, binId: "bin", pairingKey: KEY }, { run: async () => { throw new Error("x"); } });
    try {
        await svc.check();
        assert.match(st.meta.loginLinks[PID_RAIMOND].error, /could not start/);
        assert.equal(st.meta.loginLinks[PID_RAIMOND].url, undefined);
    } finally { server.close(); }
    // Output that is not a tailnet link is refused.
    await assert.rejects(runInlogLink("rob", 30, { exec: (c, a, o, cb) => cb(null, "oops\nhttp://evil/x\n") }));
    assert.equal(await runInlogLink("rob", 30, { exec: (c, a, o, cb) => cb(null, "started\nhttp://h.ts.net:8791/" + "b".repeat(48) + "\n") }), "http://h.ts.net:8791/" + "b".repeat(48));
});

test("login link: the stream triggers the work (push); no request, no run", async () => {
    const { createLoginService } = await import("../inlog.mjs");
    const st = { puts: 0, meta: { schema: 2 } };
    const { server, sse } = await fakeMetaDb(st);
    const calls = [];
    const svc = createLoginService(config, { dbUrl: `http://127.0.0.1:${server.address().port}`, binId: "bin", pairingKey: KEY },
        { run: async n => { calls.push(n); return "http://h.ts.net:8791/" + "c".repeat(48); } });
    const stream = svc.startStream();
    try {
        await waitFor(() => sse.size === 1);
        await new Promise(r => setTimeout(r, 150));
        assert.equal(calls.length, 0);                      // initial event, nothing requested
        st.meta.loginRequests = { [PID_RAIMOND]: { at: Date.now() } };   // what the dashboard writes
        for (const c of sse) c.write("event: put\ndata: {}\n\n");
        await waitFor(() => st.meta.loginLinks && st.meta.loginLinks[PID_RAIMOND]);
        assert.deepEqual(calls, ["raimond"]);
        await new Promise(r => setTimeout(r, 150));
        assert.equal(calls.length, 1);                      // its own write on the stream does not run it again
    } finally { stream.close(); for (const c of sse) c.end(); server.close(); }
});
