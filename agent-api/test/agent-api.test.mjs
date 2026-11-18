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

// ---- v0.35.0: one profile list, "add measuring profile", public login link ----
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { pcVoorToken } from "../inname-token.mjs";
import { Worker } from "node:worker_threads";
import { gunzipSync } from "node:zlib";
const tmpDir = () => fs.mkdtempSync(path.join(here, "usage-prof-"));
const exampleList = () => JSON.parse(fs.readFileSync(path.join(here, "..", "profielen.example.json"), "utf8"));

test("profile list: example matches the four live profiles; validation; pids", async () => {
    const P = await import("../profielen.mjs");
    const list = P.validate(exampleList());
    assert.deepEqual(list.profielen.map(p => [p.naam, p.debugpoort, p.webpoort]),
        [["rob", 9231, 8791], ["raimond", 9232, 8792], ["kevin", 9233, 8793], ["kevin-lxdg", 9234, 8794]]);
    assert.equal(P.pidMap(list)["pid-muf9i094-12cwr6"], "raimond");
    assert.equal(P.startSite(P.byName(list, "kevin")), "chatgpt");
    assert.equal(P.startSite(P.byName(list, "raimond")), "claude");
    assert.ok(list.profielen.every(p => p.extern === false), "existing users are never public");
    for (const bad of [{ naam: "Bad Name" }, { naam: "rob" }, { naam: "x1", debugpoort: 9231 }]) {
        const l = exampleList(); l.profielen.push({ pid: null, start: "unit", debugpoort: 9300, webpoort: 8800, ...bad });
        assert.throws(() => P.validate(l));
    }
});

test("profile list: new ports are the first free ones; add is saved and locked", async t => {
    const P = await import("../profielen.mjs");
    const dir = tmpDir(), file = path.join(dir, "profielen.json");
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    fs.writeFileSync(file, JSON.stringify(exampleList()));
    assert.deepEqual(P.pickPorts(exampleList()), { debugpoort: 9235, webpoort: 8795 });
    assert.deepEqual(P.pickPorts(exampleList(), [9235, 8795]), { debugpoort: 9236, webpoort: 8796 });
    P.addProfiel(file, { naam: "anna", ports: P.pickPorts(exampleList()), label: "Anna" });
    const l = P.loadProfielen(file), a = P.byName(l, "anna");
    assert.deepEqual([a.start, a.extern, a.pid, a.debugpoort, a.webpoort], ["unit", false, null, 9235, 8795]);   // tailnet link unless chosen otherwise
    assert.throws(() => P.addProfiel(file, { naam: "anna", ports: { debugpoort: 9300, webpoort: 8800 } }), e => e.code === "EXISTS");
    P.setField(file, "anna", "pid", "pid-abc-123");
    assert.equal(P.pidMap(P.loadProfielen(file))["pid-abc-123"], "anna");
    assert.ok(!fs.existsSync(file + ".lock"), "lock released");
    P.syncEnv(P.loadProfielen(file), path.join(dir, "env"));
    assert.equal(fs.readFileSync(path.join(dir, "env", "anna.env"), "utf8"), "DEBUG_PORT=9235\n");
    assert.ok(!fs.existsSync(path.join(dir, "env", "kevin.env")), "script profiles have no unit env file");
    // CLI used by the shell scripts.
    const env = { ...process.env, USAGE_PROFIELEN: file };
    const get = (...a) => {
        const result = spawnSync(process.execPath, [path.join(here, "..", "profielen.mjs"), ...a], { env, encoding: "utf8", windowsHide: true });
        if (result.error) throw result.error;
        assert.equal(result.status, 0, result.stderr);
        return result.stdout.trim();
    };
    assert.equal(get("get", "anna", "webpoort"), "8795");
    assert.equal(get("names", "script").replace(/\r/g, ""), "kevin\nkevin-lxdg");
});

test("add user: ports, unit with its own debug port, pairing, pid, link; rolls back on failure", async t => {
    const { addUser, parseArgs } = await import("../usage-gebruiker-toevoegen.mjs");
    const P = await import("../profielen.mjs");
    const dir = tmpDir(), file = path.join(dir, "profielen.json");
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    process.env.USAGE_API_DIR = dir;
    fs.writeFileSync(file, JSON.stringify(exampleList()));
    const http2 = http.createServer((q, r) => r.end("{}"));
    await new Promise(r => http2.listen(0, "127.0.0.1", r));
    const calls = [], prov = [];
    const mk = (over = {}) => ({
        file, sleepFn: async () => {}, chromeDir: n => path.join(dir, "chrome-" + n), readSync: () => ({ binId: "b", pairingKey: "SECRET-KEY" }),
        portsFor: async () => ({ debugpoort: http2.address().port, webpoort: 8795 }),
        run: async (c, a) => { calls.push([path.basename(c), ...a]); return String(c).endsWith("usage-inloglink") ? "started\nhttps://h.ts.net:8443/" + "d".repeat(64) + "\n" : ""; },
        ext: { provisionSync: async (port, v) => { prov.push(v.label); return "set"; }, readProfileId: async () => "pid-new-1" }, log: () => {}, ...over
    });
    try {
        assert.equal(await addUser({ naam: "anna", min: 30 }, mk()), "https://h.ts.net:8443/" + "d".repeat(64));   // link text comes from the stub
        const a = P.byName(P.loadProfielen(file), "anna");
        assert.deepEqual([a.pid, a.extern, a.start], ["pid-new-1", false, "unit"]);
        assert.deepEqual(calls[0], ["systemctl", "--user", "enable", "--now", "chrome-usage@anna.service"]);
        assert.deepEqual(calls[1], ["usage-inloglink", "anna", "30"]);
        assert.deepEqual(prov, ["Anna"]);
        assert.equal(fs.readFileSync(path.join(dir, "chrome-env", "anna.env"), "utf8"), `DEBUG_PORT=${http2.address().port}\n`);
        // Taken and invalid names: exit codes 3 and 2, nothing changed.
        await assert.rejects(addUser({ naam: "anna" }, mk()), e => e.code === 3);
        await assert.rejects(addUser({ naam: "rob" }, mk()), e => e.code === 3);
        await assert.rejects(addUser({ naam: "Bad;name" }, mk()), e => e.code === 2);
        // Chrome that never answers: the profile is removed again, the unit disabled.
        calls.length = 0;
        await assert.rejects(addUser({ naam: "bob", min: 30 }, mk({ portsFor: async () => ({ debugpoort: 1999, webpoort: 8796 }) })), /did not start/);
        assert.equal(P.byName(P.loadProfielen(file), "bob"), undefined);
        assert.ok(calls.some(c => c.includes("disable") && c.includes("chrome-usage@bob.service")));
        // Public only when asked for.
        const http3 = http.createServer((q, r) => r.end("{}"));
        await new Promise(r => http3.listen(0, "127.0.0.1", r));
        try {
            await addUser({ naam: "carl", min: 30, extern: true }, mk({ portsFor: async () => ({ debugpoort: http3.address().port, webpoort: 8797 }) }));
            assert.equal(P.byName(P.loadProfielen(file), "carl").extern, true);
        } finally { http3.close(); }
    } finally { http2.close(); delete process.env.USAGE_API_DIR; }
    assert.deepEqual(parseArgs(["anna", "--extern", "--min", "10"]), { naam: "anna", extern: true, min: 10 });
    assert.deepEqual(parseArgs(["anna"]), { naam: "anna", extern: false, min: 30 });
    assert.equal(parseArgs(["a", "b"]), null);
});

test("login service: addRequests become an addResults entry; bad or taken names give a short error", async () => {
    const { createLoginService } = await import("../inlog.mjs");
    const now = Date.now();
    const st = { puts: 0, meta: { schema: 2, loginRequests: {}, addRequests: { a1: { name: "anna", at: now - 1000 }, a2: { name: "Bad name", at: now - 1000 }, a3: { name: "rob", at: now - 1000 }, a4: { name: "old", at: now - 3600e3 } },
        addResults: { gone: { name: "x", at: now - 2 * 86400e3 } } } };
    const { server } = await fakeMetaDb(st);
    const ran = [];
    const runAdd = async n => { ran.push(n); if (n === "rob") throw Object.assign(new Error("x"), { code: 3 }); return "https://h.ts.net:8443/" + "e".repeat(64); };
    const svc = createLoginService(config, { dbUrl: `http://127.0.0.1:${server.address().port}`, binId: "bin", pairingKey: KEY }, { runAdd });
    try {
        await svc.check();
        assert.deepEqual(ran.sort(), ["anna", "rob"]);                       // the bad name never reaches the command
        const r = st.meta.addResults;
        assert.equal(r.a1.public, true); assert.match(r.a1.url, /^https:\/\//); assert.equal(r.a1.until - r.a1.at, 30 * 60000);
        assert.equal(r.a2.error, "invalid name");
        assert.equal(r.a3.error, "name already exists");
        assert.equal(r.gone, undefined, "old results are cleaned up");
        assert.deepEqual(st.meta.addRequests, {});                           // done and stale ones removed
    } finally { server.close(); }
});

test("login service: a pid that is not in the list yet is looked up on demand", async () => {
    const { createLoginService } = await import("../inlog.mjs");
    const list = exampleList(); list.profielen.push({ naam: "anna", pid: null, diensten: ["claude"], start: "unit", debugpoort: 9235, webpoort: 8795, extern: true });
    const st = { puts: 0, meta: { schema: 2, loginRequests: { "pid-anna-1": { at: Date.now() - 500 } } } };
    const { server } = await fakeMetaDb(st);
    const calls = [];
    const svc = createLoginService(config, { dbUrl: `http://127.0.0.1:${server.address().port}`, binId: "bin", pairingKey: KEY }, {
        profielen: () => list, resolve: () => { list.profielen.find(p => p.naam === "anna").pid = "pid-anna-1"; },
        run: async n => { calls.push(n); return "https://h.ts.net:8443/" + "f".repeat(64); } });
    try { await svc.check(); assert.deepEqual(calls, ["anna"]); assert.match(st.meta.loginLinks["pid-anna-1"].url, /^https:/); } finally { server.close(); }
});

test("runForLink accepts tailnet and Funnel links only", async () => {
    const { runForLink } = await import("../inlog.mjs");
    const ok = out => runForLink("x", [], { exec: (c, a, o, cb) => cb(null, out) });
    assert.equal(await ok("https://h.ts.net:8443/" + "a".repeat(64) + "\n"), "https://h.ts.net:8443/" + "a".repeat(64));
    assert.equal(await ok("http://h.ts.net:8791/" + "a".repeat(48)), "http://h.ts.net:8791/" + "a".repeat(48));
    await assert.rejects(ok("https://evil.example/short"));
    await assert.rejects(runForLink("x", [], { exec: (c, a, o, cb) => cb(Object.assign(new Error("e"), { code: 3 }), "") }), e => e.code === 3);
});

test("usage-inloglink: public Funnel link only for extern profiles; Funnel off again; token not passed on", t => {
    const dir = tmpDir(), bin = path.join(dir, "bin"), log = path.join(dir, "calls.log");
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    fs.mkdirSync(bin);
    const stub = (name, body) => { fs.writeFileSync(path.join(bin, name), "#!/bin/bash\n" + body + "\n", { mode: 0o755 }); };
    stub("systemctl", "exit 0");
    stub("systemd-run", `echo "systemd-run $*" >> "${log}"`);
    stub("journalctl", 'echo "inloglink x actief op 127.0.0.1:1, 30 min"');
    stub("openssl", 'n=$3; printf "%${n}s" "" | tr " " a; printf "%${n}s" "" | tr " " a; echo');
    stub("python3", "cat >/dev/null; echo agents.tail.ts.net");   // read stdin: else the upstream echo can get SIGPIPE (status 141) under pipefail
    stub("tailscale", `if [ "$1 $2" = "status --json" ]; then echo '{}'; exit 0; fi
if [ "$1 $2" = "funnel status" ]; then echo "$FUNNEL_STATUS"; exit 0; fi
echo "tailscale $*" >> "${log}"`);
    const list = exampleList(); list.profielen.push({ naam: "anna", pid: null, diensten: ["claude"], start: "unit", debugpoort: 9235, webpoort: 8795, extern: true });
    const file = path.join(dir, "profielen.json"); fs.writeFileSync(file, JSON.stringify(list));
    const run = (args, extra = {}) => {
        fs.writeFileSync(log, "");
        const r = spawnSync("bash", [path.join(here, "..", "usage-inloglink"), ...args], { encoding: "utf8", windowsHide: true, env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH, USAGE_PROFIELEN: file, FUNNEL_STATUS: "", ...extra } });
        if (r.error) throw r.error;
        return { out: r.stdout.trim(), err: r.stderr, status: r.status, log: fs.readFileSync(log, "utf8") };
    };
    const pub = run(["anna", "120"]);
    assert.equal(pub.out, "https://agents.tail.ts.net:8443/" + "a".repeat(64), pub.err);
    assert.match(pub.log, /INLOG_FUNNEL=1/);
    assert.match(pub.log, /RuntimeMaxSec=3660/, "capped at 60 min");
    assert.match(pub.log, /ExecStopPost=.*funnel --https=8443 off/);
    assert.match(pub.log, /tailscale funnel --bg --https=8443 http:\/\/127\.0\.0\.1:8795/);
    assert.ok(!/tailscale [^\n]*a{32}/.test(pub.log), "the token never goes to tailscale");
    const priv = run(["rob"]);
    assert.equal(priv.out, "http://agents.tail.ts.net:8791/" + "a".repeat(48), priv.err + " status=" + priv.status);
    assert.ok(!/funnel|INLOG_FUNNEL/.test(priv.log), "Rob stays tailnet-only");
    assert.match(run(["anna", "--tailnet"]).out, /^http:\/\//);
    const busy = run(["anna"], { FUNNEL_STATUS: "https://x.ts.net:8443 (Funnel on)" });
    assert.notEqual(busy.status, 0); assert.match(busy.out, /in use/);
    assert.notEqual(run(["nobody"]).status, 0);
});

// Keep even temporary SQLite files inside the authorized workspace.
function historyFixture(t, overrides = {}) {
    const dir = fs.mkdtempSync(path.join(here, "historie-test-"));
    const state = { profiles: profiles(), reads: 0, metaReads: 0 };
    const cfg = { ...config, cache_s: 0, backup_map: path.join(dir, "backup"), ...overrides };
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
    const stores = [];
    const makeStore = (file = historyFile) => {
        const store = createStore(cfg, secrets, { fetchImpl, historyFile: file });
        stores.push(store);
        t.after(() => store.close());
        return store;
    };
    // Hooks run in registration order: register cleanup after store/server hooks.
    return { dir, state, cfg, historyFile, makeStore,
        cleanup: () => t.after(async () => {
            for (const store of stores) await store.close();
            fs.rmSync(dir, { recursive: true, force: true });
        }) };
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
    assert.equal(loadAll(file).innameFile, path.join(f.dir, "inname.json"));
    for (const value of [path.join("subdir", "custom.sqlite"), path.join(f.dir, "absolute.sqlite")]) {
        fs.writeFileSync(file, JSON.stringify({ historie_bestand: value, cache_bestand: value, backup_map: value, inname_bestand: value }));
        assert.equal(loadAll(file).historyFile, loadAll(file).cacheFile);
        assert.equal(loadAll(file).backupMap, loadAll(file).cacheFile);
        assert.equal(loadAll(file).innameFile, loadAll(file).cacheFile);
    }
});

// Central ingestion: real HTTP and a real worker/database, with no Firebase reads.
const PC_TOKEN = "synthetic-ingestion-token";
const OTHER_PC_TOKEN = "another-pc-token";
const tokenHash = token => createHash("sha256").update(token).digest("hex");
async function innameFixture(t, overrides = {}, historyFile, serverOptions = {}) {
    const f = historyFixture(t, overrides);
    const innameFile = path.join(f.dir, "inname.json");
    fs.writeFileSync(innameFile, JSON.stringify({ pcs: { "test-pc": tokenHash(PC_TOKEN), "other-pc": tokenHash(OTHER_PC_TOKEN) } }));
    const store = f.makeStore(historyFile);
    const server = createServer({ config: f.cfg, token: TOKEN, store, innameFile, ...serverOptions });
    const port = await listen(server);
    t.after(() => new Promise(resolve => server.close(resolve))); f.cleanup();
    const post = (body, token = PC_TOKEN, extra = {}) => fetch(`http://127.0.0.1:${port}/v1/inname`, {
        method: "POST", headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" },
        body: typeof body === "string" ? body : JSON.stringify(body), ...extra
    });
    const get = (url, token = TOKEN) => fetch(`http://127.0.0.1:${port}${url}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {}
    });
    return { ...f, store, server, port, innameFile, post, get };
}
async function withDatabase(file, fn) {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(file);
    try { return fn(db); } finally { db.close(); }
}
const plainRows = rows => rows.map(row => ({ ...row }));

test("central schema: tables, columns, indexes and version 3 exist before ingestion", async t => {
    const f = historyFixture(t), store = f.makeStore(); f.cleanup();
    await store.verloop(); // Barrier: initialization has finished in the worker.
    await withDatabase(f.historyFile, db => {
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(r => r.name).sort();
        assert.deepEqual(tables, ["berichten", "codex", "inname_log", "klussen", "metingen"]);
        assert.equal(db.prepare("PRAGMA user_version").get().user_version, 3);
        const expected = {
            berichten: "id pc tijd tijd_eind bron sessie_id titel project model input output cache_lees cache_schrijf_5m cache_schrijf_1u koud subagent prijs ontvangen_op",
            codex: "id pc tijd account sessie_id werkmap model input cached_input output reasoning usd vijf_uur_pct week_pct ontvangen_op",
            klussen: "rij vingerafdruk pc id klusmap account model start eind week_voor week_na vijf_uur_voor vijf_uur_na input output usd pr exitcode gelukt status ontvangen_op effort",
            inname_log: "rij pc tabel tijd ontvangen nieuw positie"
        };
        for (const [table, names] of Object.entries(expected)) {
            assert.deepEqual(db.prepare(`PRAGMA table_info(${table})`).all().map(r => r.name), names.split(" "));
        }
        assert.deepEqual(db.prepare("PRAGMA index_info(berichten_tijd)").all().map(r => r.name), ["tijd"]);
        assert.deepEqual(db.prepare("PRAGMA index_info(codex_account_tijd)").all().map(r => r.name), ["account", "tijd"]);
        assert.deepEqual(db.prepare("PRAGMA index_info(codex_tijd)").all().map(r => r.name), ["tijd"]);
        for (const table of ["berichten", "codex"]) {
            const plan = db.prepare(`EXPLAIN QUERY PLAN SELECT * FROM ${table} WHERE tijd >= ? AND tijd < ?`)
                .all("2026-11-10", "2026-11-11");
            assert.ok(plan.some(row => row.detail.includes(`USING INDEX ${table}_tijd`)));
        }
    });
});

test("ingestion: all tables are idempotent, whitelist fields, stamp pc and audit each block", async t => {
    const f = await innameFixture(t);
    for (const tabel of ["berichten", "codex", "klussen"]) {
        const body = { tabel, pc: "forged", positie: 42, rijen: [{ id: `${tabel}-1`, tijd: "2026-11-01T10:00:00Z", pc: "forged", ontvangen_op: "forged", extra: { ignored: true } }] };
        const first = await f.post(body);
        assert.equal(first.status, 200);
        assert.deepEqual(await first.json(), { ok: true, tabel, ontvangen: 1, nieuw: 1, positie: 42, backup: new Date().toISOString().slice(0, 10) });
        const duplicate = await f.post(body);
        assert.equal((await duplicate.json()).nieuw, 0);
        await withDatabase(f.historyFile, db => {
            const rows = db.prepare(`SELECT * FROM ${tabel}`).all();
            assert.equal(rows.length, 1);
            assert.equal(rows[0].pc, "test-pc");
            assert.ok(Number.isFinite(Date.parse(rows[0].ontvangen_op)));
            assert.ok(!("extra" in rows[0]));
            const log = db.prepare("SELECT pc, tabel, ontvangen, nieuw, positie FROM inname_log WHERE tabel = ? ORDER BY rij").all(tabel);
            assert.deepEqual(plainRows(log), [
                { pc: "test-pc", tabel, ontvangen: 1, nieuw: 1, positie: 42 },
                { pc: "test-pc", tabel, ontvangen: 1, nieuw: 0, positie: 42 }
            ]);
        });
    }
    assert.equal(f.state.reads, 0);
});

test("ingestion: a Codex price backfill changes only the missing price", async t => {
    const f = await innameFixture(t);
    const original = { id: "unpriced", tijd: "2026-11-10T10:00:00Z", account: "account1", model: "gpt-6.2-sol", input: 100, output: 20 };
    const post = async rijen => {
        const response = await f.post({ tabel: "codex", rijen });
        assert.equal(response.status, 200);
        return (await response.json()).nieuw;
    };
    const stored = () => withDatabase(f.historyFile, db => ({ ...db.prepare("SELECT * FROM codex WHERE id = ?").get(original.id) }));
    const prices = async () => (await (await f.get("/v1/verbruik?van=2026-11-10&tot=2026-11-10&groep=model")).json()).rijen[0];
    assert.equal(await post([original]), 1);
    const before = await stored();
    assert.equal(before.usd, null);
    const unpriced = await prices();
    assert.equal(unpriced.usd, null);
    assert.equal(unpriced.regels_zonder_prijs, 1);
    assert.equal(await post([{ ...original, usd: null }]), 0);
    assert.deepEqual(await stored(), before);
    const repriced = { ...original, tijd: "2026-11-11T10:00:00Z", account: "account2", input: 999, week_pct: 80, usd: 0.25 };
    assert.equal(await post([repriced]), 0);
    assert.deepEqual(await stored(), { ...before, usd: 0.25 });
    assert.equal(await post([repriced, { ...repriced, usd: 1.5 }, { ...repriced, usd: null }]), 0);
    assert.deepEqual(await stored(), { ...before, usd: 0.25 });
    assert.deepEqual(await f.store.verloop(), { metingen: [] });
    assert.deepEqual(await prices(), { ...unpriced, usd: 0.25, regels_zonder_prijs: 0 });
});

test("ingestion: waits for a short SQLite write lock and commits once", async t => {
    const f = historyFixture(t), store = f.makeStore(); f.cleanup();
    await store.verloop();
    const { DatabaseSync } = await import("node:sqlite");
    const lock = new DatabaseSync(f.historyFile);
    lock.exec("BEGIN EXCLUSIVE");
    const body = { tabel: "codex", pc: "test-pc", rijen: [{ id: "after-lock" }] };
    const pending = store.inname(body);
    let result;
    try {
        result = await Promise.race([pending, new Promise(resolve => setTimeout(resolve, 200))]);
    } finally {
        lock.close();
    }
    assert.equal(result, undefined, "inname should wait until the lock is released");
    assert.equal((await pending).nieuw, 1);
    assert.equal((await store.inname(body)).nieuw, 0);
});

test("jobs: snapshots share an id, fingerprint ignores pc, unknown fields and object key order", async t => {
    const f = await innameFixture(t);
    const lopend = { id: "job-1", status: "lopend", model: "sol" };
    const klaar = { model: "sol", status: "klaar", id: "job-1", exitcode: 0, gelukt: true };
    assert.equal((await (await f.post({ tabel: "klussen", rijen: [lopend, klaar] })).json()).nieuw, 2);
    assert.equal((await (await f.post({ tabel: "klussen", rijen: [{ ...lopend, pc: "other", unknown: 1 }, klaar] })).json()).nieuw, 0);
    await withDatabase(f.historyFile, db => {
        const rows = db.prepare("SELECT id, status, vingerafdruk, gelukt FROM klussen ORDER BY rij").all();
        assert.deepEqual(rows.map(r => [r.id, r.status, r.gelukt]), [["job-1", "lopend", null], ["job-1", "klaar", 1]]);
        assert.notEqual(rows[0].vingerafdruk, rows[1].vingerafdruk);
        const fields = ["id", "klusmap", "account", "model", "start", "eind", "week_voor", "week_na", "vijf_uur_voor", "vijf_uur_na", "input", "output", "usd", "pr", "exitcode", "gelukt", "status"];
        assert.equal(rows[0].vingerafdruk, tokenHash(JSON.stringify(fields.map(key => lopend[key] ?? null))));
    });
});

test("Codex deletions are scoped to the authenticated PC and audit only deleted rows", async t => {
    const f = await innameFixture(t);
    assert.equal((await f.post({ tabel: "codex", rijen: [{ id: "own" }] })).status, 200);
    assert.equal((await f.post({ tabel: "codex", rijen: [{ id: "foreign" }] }, OTHER_PC_TOKEN)).status, 200);
    const body = { tabel: "codex_verwijderd", pc: "other-pc", positie: 3,
        rijen: [{ id: "own" }, { id: "foreign", pc: "other-pc" }, { id: "missing" }] };
    assert.equal((await f.post(body, TOKEN)).status, 401);
    const response = await f.post(body);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, tabel: body.tabel, ontvangen: 3, nieuw: 1, positie: 3,
        backup: new Date().toISOString().slice(0, 10) });
    assert.equal((await (await f.post(body)).json()).nieuw, 0);
    await withDatabase(f.historyFile, db => {
        assert.deepEqual(plainRows(db.prepare("SELECT id, pc FROM codex").all()), [{ id: "foreign", pc: "other-pc" }]);
        const log = db.prepare("SELECT pc, ontvangen, nieuw, positie FROM inname_log WHERE tabel = ? ORDER BY rij").all(body.tabel);
        assert.deepEqual(plainRows(log), [
            { pc: "test-pc", ontvangen: 3, nieuw: 1, positie: 3 },
            { pc: "test-pc", ontvangen: 3, nieuw: 0, positie: 3 }
        ]);
    });
});

test("codex measurements: sort, deduplicate percentages, preserve week reset zero and backfill", async t => {
    const f = await innameFixture(t);
    const rows = [73, 73, 0].map((week_pct, i) => ({ id: `c-${i}`, account: "account1", tijd: `2026-11-0${i + 2}T10:00:00Z`, week_pct }));
    assert.equal((await (await f.post({ tabel: "codex", rijen: [...rows].reverse() })).json()).nieuw, 3);
    assert.equal((await (await f.post({ tabel: "codex", rijen: rows })).json()).nieuw, 0);
    let measurements = (await f.store.verloop({ account: "account1" })).metingen;
    assert.deepEqual(measurements.map(r => [r.laatst_gezien, r.week_pct, r.bron, r.dienst]), [
        [rows[2].tijd, 0, "codex", "chatgpt"], [rows[0].tijd, 73, "codex", "chatgpt"]
    ]);
    const older = { id: "older", account: "account1", tijd: "2026-11-01T10:00:00Z", week_pct: 70 };
    assert.equal((await (await f.post({ tabel: "codex", rijen: [older] })).json()).nieuw, 1);
    measurements = (await f.store.verloop({ account: "account1" })).metingen;
    assert.deepEqual(measurements.map(r => r.week_pct), [0, 73, 70]);
    // Same percentages at a new timestamp are suppressed; 5h-only and other accounts work.
    await f.post({ tabel: "codex", rijen: [
        { ...rows[2], id: "same", tijd: "2026-11-05T10:00:00Z" },
        { id: "five", account: "account1", tijd: "2026-11-06T10:00:00Z", vijf_uur_pct: 0 },
        { id: "other-account", account: "account2", tijd: rows[0].tijd, week_pct: 73 },
        { id: "no-percent", account: "account1", tijd: "2026-11-07T10:00:00Z" }
    ] });
    assert.equal((await f.store.verloop({ account: "account1" })).metingen.length, 4);
    assert.equal((await f.store.verloop({ account: "account2" })).metingen.length, 1);
});

test("ingestion auth and validation: fail whole invalid requests, block LAN and preserve GET", async t => {
    const f = await innameFixture(t);
    const valid = { tabel: "berichten", rijen: [{ id: "valid" }] };
    for (const token of [null, TOKEN, "wrong"]) assert.equal((await f.post(valid, token)).status, 401);
    for (const body of ["{", "null", {}, { ...valid, tabel: "metingen" }, { ...valid, tabel: "toString" },
        { ...valid, rijen: [] }, { ...valid, rijen: Array(5001).fill({ id: "x" }) },
        { ...valid, rijen: [{ id: "should-not-insert" }, { id: "bad-model", model: { invalid: true } }] },
        ...[null, [], "x", {}, { id: "" }, { id: null }, { id: 0 }].map(row => ({ ...valid, rijen: [{ id: "should-not-insert" }, row] })),
        ...[-1, 1.5, "1", null, Number.MAX_SAFE_INTEGER + 1].map(positie => ({ ...valid, positie }))]) {
        assert.equal((await f.post(body)).status, 400);
    }
    assert.equal((await f.post(valid)).status, 200);
    const read = await fetch(`http://127.0.0.1:${f.port}/v1/verloop`, { headers: { Authorization: `Bearer ${PC_TOKEN}` } });
    assert.equal(read.status, 401);
    assert.equal((await f.post(valid, PC_TOKEN, { method: "PUT" })).status, 405);
    await withDatabase(f.historyFile, db => assert.equal(db.prepare("SELECT count(*) AS n FROM berichten").get().n, 1));
    f.cfg.toegestaan = ["100.64.0.0/10"];
    assert.equal((await f.post(valid)).status, 403);
});

test("ingestion body size: Content-Length and chunked requests are capped at 8 MiB", async t => {
    const f = await innameFixture(t);
    const large = JSON.stringify({ tabel: "berichten", rijen: [{ id: "large", titel: "x".repeat(8 * 1024 * 1024) }] });
    assert.equal((await f.post(large)).status, 413);
    const response = await new Promise((resolve, reject) => {
        const req = http.request({ hostname: "127.0.0.1", port: f.port, path: "/v1/inname", method: "POST", headers: { Authorization: `Bearer ${PC_TOKEN}` } }, res => {
            res.resume(); res.on("end", () => resolve(res.statusCode));
        });
        req.on("error", reject);
        for (let i = 0; i < large.length; i += 65536) req.write(large.slice(i, i + 65536));
        req.end();
    });
    assert.equal(response, 413);
    assert.equal((await (await f.post({ tabel: "berichten", rijen: [{ id: "small" }] })).json()).nieuw, 1);
});

test("ingestion tokens reload on a newer file and fail closed on removal or malformed JSON", async t => {
    const f = await innameFixture(t);
    const body = { tabel: "berichten", rijen: [{ id: "reload" }] };
    assert.equal((await f.post(body)).status, 200);
    const replacement = "synthetic-replacement-token";
    fs.writeFileSync(f.innameFile, JSON.stringify({ pcs: { "second-pc": tokenHash(replacement) } }));
    const newer = new Date(Date.now() + 5000); fs.utimesSync(f.innameFile, newer, newer);
    assert.equal((await f.post(body)).status, 401);
    assert.equal((await f.post({ ...body, rijen: [{ id: "replacement" }] }, replacement)).status, 200);
    await withDatabase(f.historyFile, db => assert.equal(db.prepare("SELECT pc FROM berichten WHERE id = 'replacement'").get().pc, "second-pc"));
    fs.unlinkSync(f.innameFile);
    assert.equal((await f.post(body, replacement)).status, 401);
    fs.writeFileSync(f.innameFile, "{");
    assert.equal((await f.post(body, replacement)).status, 401);
});

test("ingestion: absent or broken history returns 503 and usage remains available", async t => {
    for (const mode of ["disabled", "broken"]) await t.test(mode, async t => {
        const errors = []; t.mock.method(console, "error", line => errors.push(line));
        const f = await innameFixture(t, {}, mode === "disabled" ? null : path.join(here, "absent-parent", "history.sqlite"));
        const response = await f.post({ tabel: "berichten", rijen: [{ id: "x" }] });
        assert.equal(response.status, 503);
        assert.deepEqual(await response.json(), { fout: "historie niet beschikbaar" });
        const usage = await fetch(`http://127.0.0.1:${f.port}/v1/usage`, { headers: { Authorization: `Bearer ${TOKEN}` } });
        assert.equal(usage.status, 200);
        assert.equal(errors.length, mode === "disabled" ? 0 : 1);
    });
});

test("ingestion transaction: database failure rolls back rows, derived measurements and audit together", async t => {
    const errors = []; t.mock.method(console, "error", line => errors.push(line));
    const f = await innameFixture(t);
    await f.store.verloop();
    await withDatabase(f.historyFile, db => db.exec(`CREATE TRIGGER reject_test_row BEFORE INSERT ON codex
        WHEN NEW.id = 'reject' BEGIN SELECT RAISE(ABORT, 'synthetic database failure'); END;`));
    const response = await f.post({ tabel: "codex", rijen: [
        { id: "first", account: "account1", tijd: "2026-11-01T00:00:00Z", week_pct: 73 },
        { id: "reject", account: "account1", tijd: "2026-11-02T00:00:00Z", week_pct: 0 }
    ] });
    assert.equal(response.status, 503);
    await withDatabase(f.historyFile, db => {
        for (const table of ["codex", "metingen", "inname_log"]) {
            assert.equal(db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n, 0);
        }
    });
    assert.equal(errors.length, 1);
});

test("daily backup: committed rows, one file per UTC day, 14 day retention and restart", async t => {
    const f = await innameFixture(t);
    fs.mkdirSync(f.cfg.backup_map);
    const old = path.join(f.cfg.backup_map, "usage-2000-01-01.sqlite");
    const recent = path.join(f.cfg.backup_map, "usage-2000-01-03.sqlite");
    const untouched = path.join(f.cfg.backup_map, "other.sqlite");
    for (const [file, age] of [[old, 15], [recent, 13], [untouched, 15]]) {
        fs.writeFileSync(file, "old backup");
        const time = new Date(Date.now() - age * 86400e3); fs.utimesSync(file, time, time);
    }
    const body = id => ({ tabel: "berichten", rijen: [{ id }] });
    const first = await (await f.post(body("one"))).json();
    const day = new Date().toISOString().slice(0, 10);
    assert.equal(first.backup, day);
    const target = path.join(f.cfg.backup_map, `usage-${day}.sqlite`);
    const stat = fs.statSync(target);
    await withDatabase(target, db => {
        assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
        assert.equal(db.prepare("SELECT id FROM berichten").get().id, "one");
        assert.equal(db.prepare("SELECT nieuw FROM inname_log").get().nieuw, 1);
    });
    assert.equal(fs.existsSync(old), false);
    assert.equal(fs.existsSync(recent), true);
    assert.equal(fs.existsSync(untouched), true);
    await f.post(body("two"));
    assert.equal(fs.statSync(target).mtimeMs, stat.mtimeMs);
    await f.store.close();
    const reopened = f.makeStore();
    const result = await reopened.inname({ tabel: "berichten", pc: "test-pc", rijen: [{ id: "three" }] });
    assert.equal(result.backup, day);
    assert.equal(fs.statSync(target).mtimeMs, stat.mtimeMs);
    assert.equal(fs.readdirSync(f.cfg.backup_map).filter(n => n.startsWith("usage-")).length, 2);
});

test("daily backup: existing bewaar path backs up its committed measurements", async t => {
    const f = historyFixture(t), store = f.makeStore(); f.cleanup();
    await store.usage(NOW);
    await store.verloop();
    const target = path.join(f.cfg.backup_map, `usage-${new Date().toISOString().slice(0, 10)}.sqlite`);
    await withDatabase(target, db => assert.equal(db.prepare("SELECT count(*) AS n FROM metingen").get().n, 4));
});

test("daily backup failure: write succeeds, diagnostic is one line and only once per day", async t => {
    const errors = []; t.mock.method(console, "error", line => errors.push(line));
    const f = await innameFixture(t);
    fs.writeFileSync(f.cfg.backup_map, "cannot be a directory");
    for (const id of ["one", "two"]) {
        const response = await f.post({ tabel: "berichten", rijen: [{ id }] });
        assert.equal(response.status, 200);
        assert.equal((await response.json()).backup, null);
    }
    assert.equal(errors.length, 1);
    assert.ok(!/[\r\n]/.test(errors[0]));
    await withDatabase(f.historyFile, db => assert.equal(db.prepare("SELECT count(*) AS n FROM berichten").get().n, 2));
});

test("migration: old metingen database is extended without changing existing rows", async t => {
    const f = historyFixture(t);
    await withDatabase(f.historyFile, db => {
        db.exec(`CREATE TABLE metingen (
            id INTEGER PRIMARY KEY, gelezen_op TEXT, account TEXT, dienst TEXT,
            laatst_gezien TEXT, vijf_uur_pct REAL, vijf_uur_reset TEXT, week_pct REAL,
            week_reset TEXT, bron TEXT, reset_tegoeden INTEGER, reset_tegoeden_json TEXT,
            UNIQUE(account, laatst_gezien)
        ); INSERT INTO metingen (account, laatst_gezien, week_pct, bron) VALUES ('old', '2026-01-01T00:00:00Z', 45, 'api');`);
    });
    const store = f.makeStore(); f.cleanup();
    const rows = (await store.verloop()).metingen;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].week_pct, 45);
    assert.equal(rows[0].account, "old");
    await withDatabase(f.historyFile, db => {
        assert.equal(db.prepare("PRAGMA user_version").get().user_version, 3);
        assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'").get().n, 5);
    });
});

test("migration: version 2 jobs retain their fingerprint and expose null effort", async t => {
    const f = historyFixture(t);
    const first = f.makeStore();
    const legacy = { id: "legacy-job", status: "klaar" };
    const send = (store, row) => store.inname({ tabel: "klussen", pc: "test-pc", rijen: [row] });
    assert.equal((await send(first, legacy)).nieuw, 1);
    await first.close();
    await withDatabase(f.historyFile, db => db.exec("ALTER TABLE klussen DROP COLUMN effort; PRAGMA user_version = 2"));

    const store = f.makeStore(); f.cleanup();
    assert.equal((await store.klussen()).klussen[0].effort, null);
    assert.equal((await send(store, { ...legacy, effort: "high" })).nieuw, 1);
    assert.equal((await send(store, legacy)).nieuw, 0);
    assert.equal((await send(store, { ...legacy, effort: null })).nieuw, 0);
    assert.equal((await send(store, { ...legacy, effort: "high" })).nieuw, 0);
    const { klussen } = await store.klussen();
    assert.deepEqual(klussen.map(({ id, effort }) => [id, effort]), [[legacy.id, "high"]]);
    await withDatabase(f.historyFile, db => {
        assert.equal(db.prepare("PRAGMA user_version").get().user_version, 3);
        const column = db.prepare("PRAGMA table_info(klussen)").all().find(row => row.name === "effort");
        assert.equal(column.type, "TEXT");
        assert.equal(db.prepare("SELECT count(*) AS n FROM klussen").get().n, 2);
    });
});

test("inname-token CLI: random token once, hash only, private mode, replace pc and custom path", async t => {
    const dir = tmpDir(); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const configPath = path.join(dir, "config.json"), file = path.join(dir, "private", "pcs.json");
    fs.writeFileSync(configPath, JSON.stringify({ inname_bestand: path.join("private", "pcs.json") }));
    // Execute the actual CLI entry point in an isolated Node worker, capturing
    // stdout/stderr without emitting generated credentials into the test report.
    const run = pc => new Promise((resolve, reject) => {
        const worker = new Worker(new URL("../inname-token.mjs", import.meta.url), {
            argv: [pc], env: { ...process.env, USAGE_API_CONFIG: configPath }, stdout: true, stderr: true
        });
        let stdout = "", stderr = "";
        worker.stdout.on("data", chunk => { stdout += chunk; });
        worker.stderr.on("data", chunk => { stderr += chunk; });
        worker.on("error", reject);
        worker.on("exit", status => resolve({ status, stdout, stderr }));
    });
    const first = await run("test-pc");
    assert.equal(first.status, 0); assert.equal(first.stderr, "");
    assert.ok(/^[a-f0-9]{64}\n$/.test(first.stdout), "one random 32-byte hex token");
    const contents = fs.readFileSync(file, "utf8");
    assert.ok(!contents.includes(first.stdout.trim()), "no plaintext credential in file");
    const saved = JSON.parse(contents);
    assert.ok(saved.pcs["test-pc"] === tokenHash(first.stdout.trim()), "only SHA-256 is stored");
    assert.equal(pcVoorToken(`Bearer ${first.stdout.trim()}`, saved), "test-pc");
    if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const second = await run("test-pc");
    assert.equal(second.status, 0);
    assert.ok(first.stdout !== second.stdout, "rotation creates a fresh token");
    const rotated = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(pcVoorToken(`Bearer ${first.stdout.trim()}`, rotated), null);
    assert.equal(pcVoorToken(`bearer ${second.stdout.trim()}`, rotated), "test-pc");
    for (const pc of ["Bad PC", "a".repeat(33), "../bad", ""]) {
        const bad = await run(pc);
        assert.equal(bad.status, 1); assert.equal(bad.stdout, "");
    }
    for (const header of [null, "", "Basic x", "Bearer wrong"]) assert.equal(pcVoorToken(header, rotated), null);
    assert.equal(pcVoorToken(`Bearer ${second.stdout.trim()}`, { pcs: { malformed: "not-hex" } }), null);
    assert.equal(pcVoorToken("Bearer x", null), null);
    // No config file: default inname.json is still beside that config path.
    fs.unlinkSync(configPath);
    assert.equal((await run("other-pc")).status, 0);
    assert.equal(fs.existsSync(path.join(dir, "inname.json")), true);
});

// Read endpoints: use ingestion to exercise the same append-only data as production.
async function seedVerbruik(f) {
    const berichten = [
        { id: "b1", tijd: "2026-11-10T00:00:00Z", model: "fable", titel: "plan", input: 100, output: 10, cache_lees: 20, cache_schrijf_5m: 3, cache_schrijf_1u: 5, prijs: 0.123456 },
        { id: "b2", tijd: "2026-11-10T12:00:00Z", model: "fable", titel: "plan", input: 50, cache_schrijf_1u: 7, prijs: 0.00005 },
        { id: "b3", tijd: "2026-11-10T23:59:59Z", model: "nova", titel: null, project: "repo", output: 4, cache_lees: 2, cache_schrijf_5m: 2 },
        { id: "b4", tijd: "2026-11-11T12:00:00Z" },
        { id: "b5", tijd: "2026-11-12T23:59:59.999Z", model: "fable", titel: "", project: "geen-fallback", input: 8, output: 9, cache_lees: 1, cache_schrijf_5m: 1, cache_schrijf_1u: 1, prijs: 0.75 },
        { id: "outside-before", tijd: "2026-11-09T23:59:59.999999Z", input: 999 },
        { id: "outside-after", tijd: "2026-11-13T00:00:00.000Z", input: 999 }
    ];
    const codex = [
        { id: "c1", tijd: "2026-11-10T00:00:00.000Z", account: "account1", model: "sol", werkmap: "C:\\GitRepos\\build", input: 200, output: 20, reasoning: 7, cached_input: 80, usd: 0.20002 },
        { id: "c2", tijd: "2026-11-10T12:00:00Z", account: "account1", model: "sol", werkmap: "/home/build", input: 40, reasoning: 3, usd: 0.00004 },
        { id: "c3", tijd: "2026-11-10T12:00:00Z", account: "claude", model: "gpt-6.2-astra", werkmap: "/home\\mixed" },
        { id: "c4", tijd: "2026-11-11T12:00:00Z", account: "account2", model: "luna", werkmap: "/tmp/other/", input: 5, output: 6, cached_input: 2, usd: 0 },
        { id: "c5", tijd: "2026-11-12T23:59:59.999Z", account: "account1", model: "sol", input: 10, reasoning: 4, cached_input: 3, usd: 0.5 },
        { id: "outside-before", tijd: "2026-11-09T23:59:59.999Z", input: 999 },
        { id: "outside-after", tijd: "2026-11-13T00:00:00Z", input: 999 }
    ];
    for (const [tabel, rijen] of [["berichten", berichten], ["codex", codex]]) {
        assert.equal((await (await f.post({ tabel, rijen })).json()).nieuw, rijen.length);
    }
}
const verbruikPeriode = "/v1/verbruik?van=2026-11-10&tot=2026-11-12";
const totals = (regels, input, output, cache_lees, cache_schrijf, usd, regels_zonder_prijs = 0) => ({
    regels, input, output, cache_lees, cache_schrijf, usd, regels_zonder_prijs
});

test("HTTP verbruik: three inclusive UTC days, correct sums, nulls and separate sources", async t => {
    const f = await innameFixture(t);
    await seedVerbruik(f);
    const response = await f.get(verbruikPeriode);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
        van: "2026-11-10", tot: "2026-11-12", groep: ["dag", "account"], rijen: [
            { dag: "2026-11-10", account: "account1", bron: "codex", ...totals(2, 240, 20, 80, 0, 0.2001) },
            { dag: "2026-11-10", account: "claude", bron: "claude", ...totals(3, 150, 14, 22, 17, 0.1235, 1) },
            { dag: "2026-11-10", account: "claude", bron: "codex", ...totals(1, 0, 0, 0, 0, null, 1) },
            { dag: "2026-11-11", account: "account2", bron: "codex", ...totals(1, 5, 6, 2, 0, 0) },
            { dag: "2026-11-11", account: "claude", bron: "claude", ...totals(1, 0, 0, 0, 0, null, 1) },
            { dag: "2026-11-12", account: "account1", bron: "codex", ...totals(1, 10, 0, 3, 0, 0.5) },
            { dag: "2026-11-12", account: "claude", bron: "claude", ...totals(1, 8, 9, 1, 2, 0.75) }
        ]
    });
    const byDay = await (await f.get(`${verbruikPeriode}&groep=dag`)).json();
    assert.equal(byDay.rijen.length, 6);
    assert.deepEqual(byDay.rijen.slice(0, 2), [
        { dag: "2026-11-10", bron: "claude", ...totals(3, 150, 14, 22, 17, 0.1235, 1) },
        { dag: "2026-11-10", bron: "codex", ...totals(3, 240, 20, 80, 0, 0.2001, 1) }
    ]);
    assert.equal(f.state.reads, 0, "read endpoints must not fetch Firebase");
});

test("HTTP verbruik: all group fields, path styles, source filter and requested sort order", async t => {
    const f = await innameFixture(t);
    await seedVerbruik(f);
    const result = await (await f.get(`${verbruikPeriode}&groep=dag,account,model,klus`)).json();
    assert.deepEqual(result.groep, ["dag", "account", "model", "klus"]);
    assert.deepEqual(result.rijen, [
        { dag: "2026-11-10", account: "account1", model: "sol", klus: "build", bron: "codex", ...totals(2, 240, 20, 80, 0, 0.2001) },
        { dag: "2026-11-10", account: "claude", model: "fable", klus: "plan", bron: "claude", ...totals(2, 150, 10, 20, 15, 0.1235) },
        { dag: "2026-11-10", account: "claude", model: "gpt-6.2-astra", klus: "mixed", bron: "codex", ...totals(1, 0, 0, 0, 0, null, 1) },
        { dag: "2026-11-10", account: "claude", model: "nova", klus: "repo", bron: "claude", ...totals(1, 0, 4, 2, 2, null, 1) },
        { dag: "2026-11-11", account: "account2", model: "luna", klus: "other", bron: "codex", ...totals(1, 5, 6, 2, 0, 0) },
        { dag: "2026-11-11", account: "claude", model: null, klus: null, bron: "claude", ...totals(1, 0, 0, 0, 0, null, 1) },
        { dag: "2026-11-12", account: "account1", model: "sol", klus: null, bron: "codex", ...totals(1, 10, 0, 3, 0, 0.5) },
        { dag: "2026-11-12", account: "claude", model: "fable", klus: "", bron: "claude", ...totals(1, 8, 9, 1, 2, 0.75) }
    ]);
    for (const bron of ["claude", "codex"]) {
        const filtered = await (await f.get(`${verbruikPeriode}&groep=dag,account,model,klus&bron=${bron}`)).json();
        assert.deepEqual(filtered.rijen, result.rijen.filter(row => row.bron === bron));
    }
    const byAccount = await (await f.get(`${verbruikPeriode}&groep=account&bron=codex`)).json();
    assert.deepEqual(byAccount.rijen, [
        { account: "account1", bron: "codex", ...totals(3, 250, 20, 83, 0, 0.7001) },
        { account: "account2", bron: "codex", ...totals(1, 5, 6, 2, 0, 0) },
        { account: "claude", bron: "codex", ...totals(1, 0, 0, 0, 0, null, 1) }
    ]);
    const reordered = await (await f.get(`${verbruikPeriode}&groep=account,dag`)).json();
    assert.deepEqual(reordered.rijen.map(row => [row.account, row.dag]), [
        ["account1", "2026-11-10"], ["account1", "2026-11-12"], ["account2", "2026-11-11"],
        ["claude", "2026-11-10"], ["claude", "2026-11-10"], ["claude", "2026-11-11"], ["claude", "2026-11-12"]
    ]);
});

test("HTTP verbruik: default seven-day period uses UTC and tot, empty results and 400-day boundary", async t => {
    const f = await innameFixture(t, {}, undefined, { clock: () => Date.parse("2026-11-12T23:30:00Z") });
    await f.post({ tabel: "berichten", rijen: [5, 6, 12, 13].map(day => ({ id: `default-${day}`, tijd: `2026-11-${String(day).padStart(2, "0")}T00:00:00Z` })) });
    const result = await (await f.get("/v1/verbruik")).json();
    assert.equal(result.van, "2026-11-06");
    assert.equal(result.tot, "2026-11-12");
    assert.deepEqual(result.rijen.map(row => row.dag), ["2026-11-06", "2026-11-12"]);
    const endOnly = await (await f.get("/v1/verbruik?tot=2026-11-10")).json();
    assert.equal(endOnly.van, "2026-11-04");
    assert.equal(endOnly.tot, "2026-11-10");
    const startOnly = await (await f.get("/v1/verbruik?van=2026-11-10")).json();
    assert.equal(startOnly.tot, "2026-11-12");
    assert.deepEqual(startOnly.rijen.map(row => row.dag), ["2026-11-12"]);
    assert.deepEqual(await (await f.get("/v1/verbruik?van=2026-01-01&tot=2026-01-01")).json(), {
        van: "2026-01-01", tot: "2026-01-01", groep: ["dag", "account"], rijen: []
    });
    const start = days => new Date(Date.parse("2026-11-12") - days * 86400e3).toISOString().slice(0, 10);
    assert.equal((await f.get(`/v1/verbruik?van=${start(399)}&tot=2026-11-12`)).status, 200);
    assert.equal((await f.get(`/v1/verbruik?van=${start(400)}&tot=2026-11-12`)).status, 400);
    assert.equal((await f.get("/v1/verbruik?van=2024-02-29&tot=2024-02-29")).status, 200);
    await f.post({ tabel: "berichten", rijen: [{ id: "last-day", tijd: "9999-12-31T23:59:59.999Z", input: 7 }] });
    const lastDay = await (await f.get("/v1/verbruik?van=9999-12-31&tot=9999-12-31")).json();
    assert.equal(lastDay.rijen[0].input, 7);
});

test("HTTP verbruik: invalid dates, reversed or excessive range, unknown groups and sources fail safely", async t => {
    const f = await innameFixture(t);
    for (const params of ["van=2026-2-01", "tot=2026-02-30", "van=2026-02-29", "tot=2026-13-01", "tot=wrong", "tot=", "van=", "van=2026-11-13&tot=2026-11-12", "van=2020-01-01&tot=2026-11-12",
        "groep=", "groep=dag,", "groep=dag,pc", "groep=dag);DROP%20TABLE%20berichten;--", "bron=", "bron=api"]) {
        assert.equal((await f.get(`/v1/verbruik?${params}`)).status, 400, params);
    }
    assert.equal((await f.get(verbruikPeriode)).status, 200, "invalid input must not disable the worker");
});

test("HTTP verbruik: groep uur and sessie add hourly and per-session figures, additively", async t => {
    const f = await innameFixture(t);
    const berichten = [
        { id: "u1", tijd: "2026-11-10T10:10:00Z", sessie_id: "s-aaa", titel: "Plan", project: "p1", model: "opus", input: 100000, cache_lees: 60000, prijs: 2 },
        { id: "u2", tijd: "2026-11-10T10:50:00Z", sessie_id: "s-aaa", titel: "Plan", model: "opus", input: 10, prijs: 1, subagent: 1 },
        { id: "u3", tijd: "2026-11-10T11:05:00Z", sessie_id: "s-aaa", titel: "Plan", model: "sonnet", input: 10, prijs: 0.5 },
        { id: "u4", tijd: "2026-11-10T11:30:00Z", sessie_id: "s-bbb", titel: "Test", model: "haiku", input: 10, prijs: 0.25 }
    ];
    assert.equal((await (await f.post({ tabel: "berichten", rijen: berichten })).json()).nieuw, 4);
    const base = "/v1/verbruik?van=2026-11-10&tot=2026-11-10&bron=claude";
    const clock = await (await f.get(`${base}&groep=uur`)).json();
    assert.deepEqual(clock.rijen.map(r => [r.uur, r.usd, r.groot_usd, r.subagent_usd]), [
        ["2026-11-10T10:00:00Z", 3, 2, 1], ["2026-11-10T11:00:00Z", 0.75, 0, 0]]);
    const shifted = await (await f.get(`${base}&groep=uur,model&uurstart=2026-11-10T09:30:00Z`)).json();
    assert.deepEqual(shifted.rijen.map(r => [r.uur, r.model, r.usd]), [
        [0, "opus", 2], [1, "opus", 1], [1, "sonnet", 0.5], [2, "haiku", 0.25]]);
    const before = await (await f.get(`${base}&groep=uur&uurstart=2026-11-10T10:30:00Z`)).json();
    assert.deepEqual(before.rijen.map(r => r.uur), [-1, 0, 1]);
    const sessions = await (await f.get(`${base}&groep=sessie`)).json();
    assert.deepEqual(sessions.rijen.map(r => [r.sessie, r.titel, r.regels, r.usd, r.groot_usd, r.subagent_usd, r.eerste, r.laatste]), [
        ["s-aaa", "Plan", 3, 3.5, 2, 1, "2026-11-10T10:10:00Z", "2026-11-10T11:05:00Z"],
        ["s-bbb", "Test", 1, 0.25, 0, 0, "2026-11-10T11:30:00Z", "2026-11-10T11:30:00Z"]]);
    const plain = await (await f.get(`${base}&groep=dag`)).json();
    assert.deepEqual(Object.keys(plain.rijen[0]), ["dag", "bron", "regels", "input", "output", "cache_lees", "cache_schrijf", "usd", "regels_zonder_prijs"]);
    for (const params of ["groep=dag&uurstart=2026-11-10T09:30:00Z", "groep=uur&uurstart=nu", "groep=uur&uurstart=2026-11-10", "groep=uur,pc"]) {
        assert.equal((await f.get(`${base}&${params}`)).status, 400, params);
    }
});

test("HTTP klussen: newest snapshot per id, complete fields, start order and inclusive timezone filter", async t => {
    const f = await innameFixture(t);
    const job = { id: "job", klusmap: "C:\\werk\\klus", account: "account1", model: "sol", start: "2026-11-10T10:00:00Z", week_voor: 1, vijf_uur_voor: 2, status: "lopend" };
    const done = { ...job, eind: "2026-11-10T11:00:00Z", week_na: 3, vijf_uur_na: 4, input: 100, output: 10, usd: 1.25, pr: "https://example.invalid/pr/1", exitcode: 0, gelukt: true, status: "klaar", effort: "high" };
    await f.post({ tabel: "klussen", rijen: [job,
        { id: "newest-start", start: "2026-11-11T12:00:00Z" }, done,
        { id: "offset", start: "2026-11-10T10:30:00+01:00" },
        { id: "changed-start", start: "2026-11-12T12:00:00Z", status: "lopend" },
        { id: "changed-start", start: "2026-11-01T12:00:00Z", status: "klaar" }
    ] });
    const response = await f.get("/v1/klussen");
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.deepEqual(result.klussen.map(row => row.id), ["newest-start", "job", "offset", "changed-start"]);
    assert.equal(result.klussen[0].effort, null);
    assert.deepEqual(result.klussen[1], { ...done, pc: "test-pc", gelukt: 1 });
    const since = await (await f.get("/v1/klussen?sinds=2026-11-10T11:00:00%2B01:00")).json();
    assert.deepEqual(since.klussen.map(row => row.id), ["newest-start", "job"]);
    assert.equal(since.klussen[1].status, "klaar");
    assert.deepEqual((await (await f.get("/v1/klussen?max=1")).json()).klussen.map(row => row.id), ["newest-start"]);
    assert.deepEqual(await (await f.get("/v1/klussen?sinds=2027-01-01T00:00:00Z")).json(), { klussen: [] });
    assert.equal(f.state.reads, 0);
});

test("HTTP klussen: default 100, maximum 1000 and invalid limits or timestamps", async t => {
    const f = await innameFixture(t);
    assert.deepEqual(await (await f.get("/v1/klussen")).json(), { klussen: [] });
    await f.post({ tabel: "klussen", rijen: Array.from({ length: 101 }, (_, i) => ({ id: `job-${i}`, start: new Date(NOW + i * 1000).toISOString() })) });
    const result = await (await f.get("/v1/klussen")).json();
    assert.equal(result.klussen.length, 100);
    assert.equal(result.klussen[0].id, "job-100");
    assert.equal((await (await f.get("/v1/klussen?max=1000")).json()).klussen.length, 101);
    for (const params of ["max=0", "max=-1", "max=1.5", "max=1001", "max=abc", "max=", "max=9007199254740992", "sinds=", "sinds=invalid", "sinds=2026-11-10", "sinds=2026-11-10T10:00:00", "sinds=2026-13-10T10:00:00Z", "sinds=2026-02-30T10:00:00Z"]) {
        assert.equal((await f.get(`/v1/klussen?${params}`)).status, 400, params);
    }
});

test("HTTP backup: gzip contains committed SQLite data and returns the latest backup date", async t => {
    const f = await innameFixture(t);
    await f.post({ tabel: "codex", rijen: [{ id: "downloaded", account: "account1", tijd: "2026-11-10T10:00:00Z", input: 123, week_pct: 42 }] });
    const day = new Date().toISOString().slice(0, 10);
    // Unrelated files and matching directories must never be selected.
    fs.writeFileSync(path.join(f.cfg.backup_map, "usage-9999-12-31.sqlite.tmp"), "ignored");
    fs.mkdirSync(path.join(f.cfg.backup_map, "usage-9999-12-31.sqlite"));
    const response = await f.get("/v1/backup");
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/gzip");
    assert.equal(response.headers.get("x-backup-datum"), day);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const bytes = gunzipSync(Buffer.from(await response.arrayBuffer()));
    assert.equal(bytes.subarray(0, 16).toString(), "SQLite format 3\0");
    const file = path.join(f.dir, "download.sqlite"); fs.writeFileSync(file, bytes);
    await withDatabase(file, db => {
        assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
        assert.deepEqual({ ...db.prepare("SELECT id, input, pc FROM codex").get() }, { id: "downloaded", input: 123, pc: "test-pc" });
        assert.equal(db.prepare("SELECT week_pct FROM metingen").get().week_pct, 42);
        assert.equal(db.prepare("SELECT nieuw FROM inname_log").get().nieuw, 1);
    });
    fs.copyFileSync(file, path.join(f.cfg.backup_map, "usage-2000-01-01.sqlite"));
    const newest = await f.get("/v1/backup");
    assert.equal(newest.headers.get("x-backup-datum"), day);
    await newest.arrayBuffer();
    assert.equal(f.state.reads, 0);
});

test("HTTP backup: missing or empty directory gives 404 and explicit backupMap overrides config", async t => {
    const f = await innameFixture(t);
    for (const makeDirectory of [false, true]) {
        if (makeDirectory) fs.mkdirSync(f.cfg.backup_map);
        const response = await f.get("/v1/backup");
        assert.equal(response.status, 404);
        assert.deepEqual(await response.json(), { fout: "geen back-up" });
    }
    const selected = path.join(f.dir, "selected"); fs.mkdirSync(selected);
    fs.writeFileSync(path.join(selected, "usage-2026-11-01.sqlite"), "selected backup");
    const server = createServer({ config: f.cfg, token: TOKEN, store: f.store, backupMap: selected });
    const port = await listen(server);
    t.after(() => new Promise(resolve => server.close(resolve)));
    const response = await fetch(`http://127.0.0.1:${port}/v1/backup`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-backup-datum"), "2026-11-01");
    assert.equal(gunzipSync(Buffer.from(await response.arrayBuffer())).toString(), "selected backup");
});

test("HTTP central reads: require the read token, enforce address rules and list all paths in 404", async t => {
    const f = await innameFixture(t);
    for (const endpoint of ["/v1/verbruik", "/v1/klussen", "/v1/backup"]) {
        for (const token of [null, "wrong", PC_TOKEN]) assert.equal((await f.get(endpoint, token)).status, 401, endpoint);
    }
    const missing = await f.get("/missing");
    assert.equal(missing.status, 404);
    const { fout } = await missing.json();
    for (const endpoint of ["/v1/usage", "/v1/verloop", "/v1/verbruik", "/v1/klussen", "/v1/backup", "POST /v1/inname"]) assert.ok(fout.includes(endpoint));
    f.cfg.toegestaan = ["192.0.2.1"];
    for (const endpoint of ["/v1/verbruik", "/v1/klussen", "/v1/backup"]) assert.equal((await f.get(endpoint)).status, 403);
});

test("HTTP central reads: unavailable history gives 503 without breaking usage", async t => {
    const f = await innameFixture(t, {}, null);
    for (const endpoint of ["/v1/verbruik", "/v1/klussen"]) {
        const response = await f.get(endpoint);
        assert.equal(response.status, 503);
        assert.deepEqual(await response.json(), { fout: "historie niet beschikbaar" });
    }
    assert.equal((await f.get("/v1/usage")).status, 200);
});

test("HTTP verloop: Codex filter combines with account, inclusive sinds and max, Firebase remains separate", async t => {
    const f = await innameFixture(t);
    await f.post({ tabel: "codex", rijen: [
        { id: "first", account: "account1", tijd: "2026-11-10T10:00:00Z", week_pct: 20 },
        { id: "second", account: "account1", tijd: "2026-11-11T10:00:00Z", week_pct: 21 },
        { id: "other", account: "account2", tijd: "2026-11-10T10:00:00Z", week_pct: 50 }
    ] });
    await f.store.usage(NOW);
    const codex = await (await f.get("/v1/verloop?bron=codex")).json();
    assert.equal(codex.metingen.length, 3);
    assert.ok(codex.metingen.every(row => row.bron === "codex"));
    const filtered = await (await f.get("/v1/verloop?bron=codex&account=account1&sinds=2026-11-10T10:00:00Z&max=1")).json();
    assert.equal(filtered.metingen.length, 1);
    assert.equal(filtered.metingen[0].laatst_gezien, "2026-11-11T10:00:00Z");
    const inclusive = await (await f.get("/v1/verloop?bron=codex&account=account1&sinds=2026-11-10T10:00:00Z")).json();
    assert.equal(inclusive.metingen.length, 2);
    assert.equal((await (await f.get("/v1/verloop?bron=api")).json()).metingen.length, 4);
    assert.deepEqual(await (await f.get("/v1/verloop?bron=unknown")).json(), { metingen: [] });
    assert.equal((await (await f.get("/v1/verloop")).json()).metingen.length, 7);
    assert.equal(f.state.reads, 1, "only the explicit usage call reads Firebase");
});

test("history bewaar: earlier Firebase reading is saved after a later Codex measurement for the same account", async t => {
    const f = await innameFixture(t);
    await f.post({ tabel: "codex", rijen: [{ id: "later", account: "account1", tijd: new Date(NOW + 60000).toISOString(), week_pct: 80 }] });
    await f.store.usage(NOW);
    let rows = (await f.store.verloop({ account: "account1" })).metingen;
    assert.deepEqual(rows.map(row => [row.bron, row.laatst_gezien, row.week_pct]), [
        ["codex", new Date(NOW + 60000).toISOString(), 80], ["api", new Date(NOW - 60000).toISOString(), 30]
    ]);
    // Non-Codex history still prevents duplicate or older Firebase readings.
    f.state.profiles = profiles({ seen: NOW - 120000, robWeek: 99 });
    await f.store.usage(NOW + 1);
    assert.deepEqual((await f.store.verloop({ account: "account1" })).metingen, rows);
    f.state.profiles = profiles({ seen: NOW, robWeek: 31 });
    await f.store.usage(NOW + 2);
    rows = (await f.store.verloop({ account: "account1" })).metingen;
    assert.deepEqual(rows.map(row => [row.bron, row.week_pct]), [["codex", 80], ["api", 31], ["api", 30]]);
});
