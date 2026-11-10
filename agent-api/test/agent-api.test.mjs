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

// ---- v0.35.0: one profile list, "add measuring profile", public login link ----
import os from "node:os";
import { spawnSync } from "node:child_process";
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "usage-prof-"));
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

test("profile list: new ports are the first free ones; add is saved and locked", async () => {
    const P = await import("../profielen.mjs");
    const dir = tmpDir(), file = path.join(dir, "profielen.json");
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
    const get = (...a) => spawnSync(process.execPath, [path.join(here, "..", "profielen.mjs"), ...a], { env, encoding: "utf8" }).stdout.trim();
    assert.equal(get("get", "anna", "webpoort"), "8795");
    assert.equal(get("names", "script").replace(/\r/g, ""), "kevin\nkevin-lxdg");
});

test("add user: ports, unit with its own debug port, pairing, pid, link; rolls back on failure", async () => {
    const { addUser, parseArgs } = await import("../usage-gebruiker-toevoegen.mjs");
    const P = await import("../profielen.mjs");
    const dir = tmpDir(), file = path.join(dir, "profielen.json");
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

test("usage-inloglink: public Funnel link only for extern profiles; Funnel off again; token not passed on", () => {
    const dir = tmpDir(), bin = path.join(dir, "bin"), log = path.join(dir, "calls.log");
    fs.mkdirSync(bin);
    const stub = (name, body) => { fs.writeFileSync(path.join(bin, name), "#!/bin/bash\n" + body + "\n", { mode: 0o755 }); };
    stub("systemctl", "exit 0");
    stub("systemd-run", `echo "systemd-run $*" >> "${log}"`);
    stub("journalctl", 'echo "inloglink x actief op 127.0.0.1:1, 30 min"');
    stub("openssl", 'n=$3; printf "%${n}s" "" | tr " " a; printf "%${n}s" "" | tr " " a; echo');
    stub("python3", "echo agents.tail.ts.net");
    stub("tailscale", `if [ "$1 $2" = "status --json" ]; then echo '{}'; exit 0; fi
if [ "$1 $2" = "funnel status" ]; then echo "$FUNNEL_STATUS"; exit 0; fi
echo "tailscale $*" >> "${log}"`);
    const list = exampleList(); list.profielen.push({ naam: "anna", pid: null, diensten: ["claude"], start: "unit", debugpoort: 9235, webpoort: 8795, extern: true });
    const file = path.join(dir, "profielen.json"); fs.writeFileSync(file, JSON.stringify(list));
    const run = (args, extra = {}) => {
        fs.writeFileSync(log, "");
        const r = spawnSync("bash", [path.join(here, "..", "usage-inloglink"), ...args], { encoding: "utf8", env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH, USAGE_PROFIELEN: file, FUNNEL_STATUS: "", ...extra } });
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
