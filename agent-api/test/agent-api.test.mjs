// node --test agent-api/test/agent-api.test.mjs
// Proves: every configured account is in /v1/usage,
// the token is required, and a database outage still answers JSON within 2 s.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { encrypt, decrypt, buildUsage, createStore, createServer, clientAllowed, loadAll } from "../server.mjs";

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

test("HTTP: ?ververs=1 asks right away and waits for the new measurement", async () => {
    const fb = { profiles: profiles({ seen: NOW - 60000 }), meta: { schema: 2 }, puts: 0, down: false };
    const fbServer = await fakeFirebase(fb);
    const cfg = { ...config, cache_s: 0, leestijd_ms: 500, ververs_lees_ms: 50, ververs_wacht_s: 2 };
    const store = createStore(cfg, { dbUrl: `http://127.0.0.1:${fbServer.address().port}`, binId: "bin", pairingKey: KEY });
    const server = createServer({ config: cfg, token: TOKEN, store, clock: () => NOW });
    const port = await listen(server);
    const get = p => fetch(`http://127.0.0.1:${port}${p}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    try {
        // Fresh data (1 min): a plain read asks nothing.
        await (await get("/v1/usage")).json();
        await new Promise(res => setTimeout(res, 100));
        assert.equal(fb.puts, 0);
        // The button: asks at once, and answers with the measurement that arrives meanwhile.
        setTimeout(() => { fb.profiles = profiles({ seen: NOW + 5000, kb: 55 }); }, 200);
        const u = await (await get("/v1/usage?ververs=1")).json();
        assert.equal(fb.puts, 1);
        assert.equal(fb.meta.refreshRequested, true);
        assert.equal(u.ververst, true);
        // No new measurement within the wait: answers anyway, ververst false.
        const t0 = Date.now();
        const v = await (await get("/v1/usage?ververs=1")).json();
        assert.equal(v.ververst, false);
        assert.ok(Date.now() - t0 < 3000);
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

// Keep even temporary SQLite files inside the authorized workspace.
function historyFixture(t, overrides = {}) {
    const dir = fs.mkdtempSync(path.join(here, "historie-test-"));
    const state = { profiles: profiles(), reads: 0, metaReads: 0 };
    const cfg = { ...config, cache_s: 0, ...overrides };
    const secrets = { dbUrl: "https://fake.invalid", binId: "bin", pairingKey: KEY };
    const fetchImpl = async (url, options) => {
        if (url.endsWith("/status.json")) {
            state.reads++;
            state.onRead?.();
            const body = Object.fromEntries(Object.entries(state.profiles).map(([id, profile]) => [id, { data: encrypt(JSON.stringify(profile), KEY) }]));
            return new Response(JSON.stringify(body));
        }
        assert.ok(url.endsWith("/meta.json"));
        if (options.method !== "PUT") state.metaReads++;
        return new Response(JSON.stringify({ data: encrypt(JSON.stringify({ schema: 2 }), KEY) }));
    };
    const historyFile = path.join(dir, "historie.sqlite");
    const makeStore = (file = historyFile) => {
        const store = createStore(cfg, secrets, { fetchImpl, historyFile: file });
        t.after(() => store.close());
        return store;
    };
    // Hooks run in registration order: register cleanup after store/server hooks.
    return { dir, state, cfg, historyFile, makeStore,
        cleanup: () => t.after(() => fs.rmSync(dir, { recursive: true, force: true })) };
}

test("history: one row per new account measurement, persistent and append-only", async t => {
    const f = historyFixture(t);
    const store = f.makeStore();
    await store.usage(NOW);
    const first = (await store.verloop({ account: "account1" })).metingen;
    assert.equal(first.length, 1);
    assert.deepEqual(first[0], {
        id: first[0].id, gelezen_op: new Date(NOW).toISOString(), account: "account1", dienst: "chatgpt",
        laatst_gezien: new Date(NOW - 60000).toISOString(), vijf_uur_pct: 20,
        vijf_uur_reset: new Date(NOW + 3600e3).toISOString(), week_pct: 30,
        week_reset: new Date(NOW + 86400e3).toISOString(), bron: "api",
        reset_tegoeden: null, reset_tegoeden_json: null
    });
    await store.usage(NOW + 1);
    assert.deepEqual((await store.verloop({ account: "account1" })).metingen, first);
    // Different values with an older timestamp must not grow or rewrite history.
    f.state.profiles = profiles({ seen: NOW - 120000, rob5h: 99 });
    await store.usage(NOW + 2);
    assert.deepEqual((await store.verloop({ account: "account1" })).metingen, first);
    const reads = f.state.reads;
    assert.equal((await store.verloop()).metingen.length, config.accounts.length);
    assert.equal(f.state.reads, reads, "history queries do not read Firebase");
    assert.equal(reads, 3);
    const rows = (await store.verloop()).metingen;
    assert.equal(rows.find(r => r.account === "account2").vijf_uur_pct, null);
    assert.equal(rows.find(r => r.account === "claude").vijf_uur_pct, 30);

    await store.close();
    const reopened = f.makeStore();
    f.cleanup();
    await reopened.usage(NOW + 3);
    assert.deepEqual((await reopened.verloop({ account: "account1" })).metingen, first);
    f.state.profiles = profiles({ seen: NOW, rob5h: 25 });
    await reopened.usage(NOW + 4);
    const newer = (await reopened.verloop({ account: "account1" })).metingen;
    assert.equal(newer.length, 2);
    assert.equal(newer[0].vijf_uur_pct, 25);
    assert.deepEqual(newer[1], first[0]);
});

test("history: fresh stores its initial read and every existing refresh read", async t => {
    const f = historyFixture(t, { ververs_lees_ms: 1, ververs_wacht_s: 1 });
    const store = f.makeStore(); f.cleanup();
    const now = Date.now();
    f.state.profiles = profiles({ seen: now - 1000 });
    f.state.onRead = () => {
        if (f.state.reads === 3) f.state.profiles = profiles({ seen: now, robWeek: 35 });
    };
    const usage = await store.usage(now, { ververs: true });
    assert.equal(usage.ververst, true);
    const rows = (await store.verloop({ account: "account1" })).metingen;
    assert.equal(rows.length, 2, "the unchanged intermediate refresh read is deduplicated");
    assert.equal(rows[0].week_pct, 35);
    assert.equal(rows[1].week_pct, 30);
    assert.equal(f.state.reads, 3);
    assert.equal(f.state.metaReads, 1);
});

test("history: reset credits preserve count, zero, unknown items and expiry dates", async t => {
    const f = historyFixture(t);
    const store = f.makeStore(); f.cleanup();
    const items = [{ title: "Reset", expiresAt: NOW + 86400e3 }];
    f.state.profiles[config.accounts[0].profiel].syncStatus.chatgpt.resetCredits = { count: 2, items };
    f.state.profiles[config.accounts[1].profiel].syncStatus.chatgpt.resetCredits = { count: 0, items: [] };
    f.state.profiles[config.accounts[2].profiel].syncStatus.chatgpt.resetCredits = { count: 3, items: null };
    await store.usage(NOW);
    const { metingen } = await store.verloop();
    assert.equal(metingen.find(r => r.account === "account1").reset_tegoeden, 2);
    assert.deepEqual(JSON.parse(metingen.find(r => r.account === "account1").reset_tegoeden_json), items);
    assert.equal(metingen.find(r => r.account === "account2").reset_tegoeden, 0);
    assert.equal(metingen.find(r => r.account === "account2").reset_tegoeden_json, "[]");
    assert.equal(metingen.find(r => r.account === "account3").reset_tegoeden, 3);
    assert.equal(metingen.find(r => r.account === "account3").reset_tegoeden_json, null);
    assert.equal(metingen.find(r => r.account === "claude").reset_tegoeden, null);
});

test("HTTP history: filters, newest first, default limit, auth and no extra reads", async t => {
    const f = historyFixture(t);
    const store = f.makeStore();
    const server = createServer({ config: f.cfg, token: TOKEN, store, clock: () => NOW });
    const port = await listen(server);
    t.after(() => new Promise(resolve => server.close(resolve))); f.cleanup();
    const get = (p, token = TOKEN, method = "GET") => fetch(`http://127.0.0.1:${port}${p}`, {
        method, headers: token ? { Authorization: `Bearer ${token}` } : {}
    });
    assert.equal((await get("/v1/verloop", null)).status, 401);
    assert.equal((await get("/v1/verloop", "wrong")).status, 401);
    assert.equal((await get("/v1/verloop", TOKEN, "POST")).status, 405);
    // 126 readings x 4 accounts: verify that the default really stops at 500.
    for (let i = 0; i < 126; i++) {
        f.state.profiles = profiles({ seen: NOW + i });
        await store.usage(NOW + i);
    }
    const all = await (await get("/v1/verloop")).json();
    assert.equal(all.metingen.length, 500);
    const filtered = await (await get(`/v1/verloop?account=account1&sinds=${new Date(NOW + 124).toISOString()}&max=1`)).json();
    assert.equal(filtered.metingen.length, 1);
    assert.equal(filtered.metingen[0].account, "account1");
    assert.equal(filtered.metingen[0].laatst_gezien, new Date(NOW + 125).toISOString());
    const inclusive = await (await get(`/v1/verloop?account=account1&sinds=${new Date(NOW + 124).toISOString()}`)).json();
    assert.equal(inclusive.metingen.length, 2);
    assert.deepEqual(await (await get("/v1/verloop?account=unknown")).json(), { metingen: [] });
    for (const p of ["max=0", "max=-1", "max=1.5", "max=abc", "sinds=invalid"]) assert.equal((await get(`/v1/verloop?${p}`)).status, 400);
    assert.equal(f.state.reads, 126);
    assert.equal(f.state.metaReads, 0);
    f.cfg.toegestaan = ["192.0.2.1"];
    assert.equal((await get("/v1/verloop")).status, 403);
});

test("history failures: corrupt or inaccessible SQLite never breaks /v1/usage", async t => {
    for (const kind of ["corrupt", "directory", "missing-parent"]) await t.test(kind, async t => {
        const errors = [];
        t.mock.method(console, "error", line => errors.push(line));
        const f = historyFixture(t);
        const historyFile = kind === "directory" ? f.dir : kind === "missing-parent" ? path.join(f.dir, "missing", "history.sqlite") : f.historyFile;
        if (kind === "corrupt") fs.writeFileSync(historyFile, "not a SQLite database");
        const store = f.makeStore(historyFile);
        const server = createServer({ config: f.cfg, token: TOKEN, store, clock: () => NOW });
        const port = await listen(server);
        t.after(() => new Promise(resolve => server.close(resolve))); f.cleanup();
        const get = p => fetch(`http://127.0.0.1:${port}${p}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
        const started = Date.now();
        const response = await get("/v1/usage");
        assert.equal(response.status, 200);
        assert.equal(ids(await response.json()), "account1,account2,account3,claude");
        assert.ok(Date.now() - started < 2000);
        assert.deepEqual(await (await get("/v1/verloop")).json(), { metingen: [], fout: "geen historie" });
        // Once disabled, repeated usage and history requests keep working.
        assert.equal((await get("/v1/usage")).status, 200);
        assert.deepEqual(await (await get("/v1/verloop")).json(), { metingen: [], fout: "geen historie" });
        assert.equal(errors.length, 1, "a history failure is only logged once");
        assert.ok(!/[\r\n]/.test(errors[0]), "the diagnostic stays on one line");
    });
});

test("history: unavailable history and disk cache do not fabricate measurements", async t => {
    const f = historyFixture(t);
    const cacheFile = path.join(f.dir, "cache.json");
    fs.writeFileSync(cacheFile, JSON.stringify({ profiles: profiles(), readAt: NOW }));
    const store = createStore({ ...f.cfg, cache_s: 20 }, { dbUrl: "https://fake.invalid", binId: "bin", pairingKey: KEY }, {
        cacheFile, historyFile: f.historyFile, fetchImpl: async () => { throw new Error("must not read Firebase"); }
    });
    t.after(() => store.close()); f.cleanup();
    assert.equal(ids(await store.usage(NOW)), "account1,account2,account3,claude");
    assert.deepEqual(await store.verloop(), { metingen: [] });
    const without = createStore(f.cfg, { dbUrl: "https://fake.invalid", binId: "bin", pairingKey: KEY });
    assert.deepEqual(await without.verloop(), { metingen: [], fout: "geen historie" });
});

test("history: a locked database write cannot break or hold up usage", async t => {
    const f = historyFixture(t);
    const store = f.makeStore(); f.cleanup();
    await store.usage(NOW);
    assert.equal((await store.verloop()).metingen.length, 4);
    const { DatabaseSync } = await import("node:sqlite");
    const lock = new DatabaseSync(f.historyFile);
    try {
        lock.exec("BEGIN EXCLUSIVE");
        f.state.profiles = profiles({ seen: NOW });
        const started = Date.now();
        const usage = await store.usage(NOW + 1);
        assert.equal(ids(usage), "account1,account2,account3,claude");
        assert.equal(usage.accounts[0].laatst_gezien, new Date(NOW).toISOString());
        assert.ok(Date.now() - started < 2000);
        assert.deepEqual(await store.verloop(), { metingen: [], fout: "geen historie" });
    } finally { lock.exec("ROLLBACK"); lock.close(); }
    assert.equal(ids(await store.usage(NOW + 2)), "account1,account2,account3,claude");
});

test("history config paths resolve beside config like cache paths", t => {
    const f = historyFixture(t); f.cleanup();
    fs.writeFileSync(path.join(f.dir, "sync.json"), JSON.stringify({ dbUrl: "fake" }));
    fs.writeFileSync(path.join(f.dir, "token"), TOKEN);
    const file = path.join(f.dir, "config.json");
    fs.writeFileSync(file, "{}");
    assert.equal(loadAll(file).historyFile, path.join(f.dir, "historie.sqlite"));
    for (const value of [path.join("subdir", "custom.sqlite"), path.join(f.dir, "absolute.sqlite")]) {
        fs.writeFileSync(file, JSON.stringify({ historie_bestand: value, cache_bestand: value }));
        assert.equal(loadAll(file).historyFile, loadAll(file).cacheFile);
    }
});
