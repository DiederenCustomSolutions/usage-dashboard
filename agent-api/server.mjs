// Usage service for AI agents: reads plus append-only central ingestion.
// GET /v1/usage uses a read token; POST /v1/inname uses a token per pc.
// Which account an agent takes is decided
// on the agents side (agents-infra), not here. Reads the same encrypted
// status nodes the dashboard reads; never measures itself. A request is the trigger:
// stale data asks the measuring Chromes for a refresh (like the dashboard's refresh
// button) and the answer comes from cache right away. No timers.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { once } from "node:events";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { pcVoorToken } from "./inname-token.mjs";

const HOME = os.homedir();
const DEFAULT_BACKUP_MAP = path.join(HOME, ".local", "share", "usage-api", "backup");
export const DEFAULT_CONFIG_PATH = process.env.USAGE_API_CONFIG || path.join(HOME, ".config", "usage-api", "config.json");

// Same XOR + base64 scheme as CryptoSync in app.js / background.js.
export function decrypt(base64Str, key) {
    const data = Buffer.from(base64Str, "base64"), k = Buffer.from(key, "utf8");
    for (let i = 0; i < data.length; i++) data[i] ^= k[i % k.length];
    return data.toString("utf8");
}
export function encrypt(text, key) {
    const data = Buffer.from(text, "utf8"), k = Buffer.from(key, "utf8");
    for (let i = 0; i < data.length; i++) data[i] ^= k[i % k.length];
    return data.toString("base64");
}

const iso = (ms) => (typeof ms === "number" && ms > 0 ? new Date(ms).toISOString() : null);
const used = (remaining) => (typeof remaining === "number" ? Math.max(0, Math.min(100, Math.round(100 - remaining))) : null);

// One account from the decrypted profile status. Field names follow syncStatus as the
// extension writes it (claude: pctRemaining = session; chatgpt: pctRemaining5h).
export function buildAccount(def, profile, { now, readOk, staleMin }) {
    const sync = (profile && profile.syncStatus && profile.syncStatus[def.dienst]) || null;
    const base = { id: def.id, naam: def.naam, eigenaar: def.eigenaar, dienst: def.dienst, abonnement: def.abonnement };
    if (!sync) return { ...base, vijf_uur: null, week: null, bron: null, laatst_gezien: null, betrouwbaar: false };
    const five = def.dienst === "claude"
        ? { pct: sync.pctRemaining, reset: sync.resetSessionAbsoluteTs }
        : { pct: sync.pctRemaining5h, reset: sync.reset5hAbsoluteTs };
    const seen = sync.lastSynced || 0;
    return {
        ...base,
        vijf_uur: used(five.pct) === null ? null : { gebruikt_pct: used(five.pct), reset: iso(five.reset) },
        week: used(sync.pctRemainingWeekly) === null ? null : { gebruikt_pct: used(sync.pctRemainingWeekly), reset: iso(sync.resetWeeklyAbsoluteTs) },
        bron: sync.source === "api" ? "api" : (sync.estimated ? "schatting" : "scraped"),
        laatst_gezien: iso(seen),
        betrouwbaar: !!readOk && seen > 0 && now - seen <= staleMin * 60000
    };
}

export function buildUsage(profiles, config, { now = Date.now(), readOk = true, readAt = now } = {}) {
    const staleMin = config.betrouwbaar_max_min ?? 15;
    return {
        gemeten_op: iso(readAt),
        accounts: config.accounts.map(def => buildAccount(def, (profiles || {})[def.profiel], { now, readOk, staleMin }))
    };
}

// ---------------------------------------------------------------------------
// Data access: one GET of the status collection, short timeout, cached on disk.

// SQLite is synchronous: keep all disk access off the HTTP thread. Messages are
// processed in order, so a history query also waits for previously queued writes.
function createHistory(historyFile, config, backupMap) {
    const unavailable = () => ({ metingen: [], fout: "geen historie" });
    let worker = null, disabled = !historyFile, nextId = 0;
    let stopping = Promise.resolve();
    const pending = new Map();
    function fail(error) {
        if (disabled) return;
        disabled = true;
        console.error(`usage-api: geen historie: ${String(error?.message || error).replace(/[\r\n]+/g, " ")}`);
        for (const resolve of pending.values()) resolve(unavailable());
        pending.clear();
        if (worker) { stopping = worker.terminate().catch(() => {}); worker = null; }
    }
    function start() {
        if (disabled) return false;
        if (worker) return true;
        try {
            worker = new Worker(new URL("./historie-worker.mjs", import.meta.url), {
                workerData: { bestand: historyFile, backupMap: backupMap ?? config.backup_map }, stderr: true
            });
            // Failures are reported explicitly; do not forward experimental
            // SQLite warnings or duplicate worker diagnostics to stderr.
            worker.stderr.resume();
            worker.on("message", message => {
                if (message.waarschuwing) { console.error(message.waarschuwing); return; }
                if (message.fout) return fail(message.fout);
                pending.get(message.id)?.(message.result);
                pending.delete(message.id);
                if (!pending.size) worker?.unref();
            });
            worker.on("error", fail);
            worker.on("exit", () => fail("historieworker gestopt"));
            worker.unref();
            return true;
        } catch (error) { fail(error); return false; }
    }
    function request(message) {
        if (!start()) return Promise.resolve(unavailable());
        return new Promise(resolve => {
            const id = ++nextId;
            pending.set(id, resolve);
            try { worker.ref(); worker.postMessage({ ...message, id }); }
            catch (error) { fail(error); }
        });
    }
    start();
    return {
        record({ profiles, readAt }) {
            if (!start()) return;
            try {
                const rows = config.accounts.map(def => {
                    const account = buildAccount(def, profiles[def.profiel], { now: readAt, readOk: true, staleMin: config.betrouwbaar_max_min ?? 15 });
                    const credits = def.dienst === "chatgpt" ? profiles[def.profiel]?.syncStatus?.chatgpt?.resetCredits : null;
                    return {
                        gelezen_op: iso(readAt), account: def.id, dienst: def.dienst,
                        laatst_gezien: account.laatst_gezien,
                        vijf_uur_pct: account.vijf_uur?.gebruikt_pct ?? null,
                        vijf_uur_reset: account.vijf_uur?.reset ?? null,
                        week_pct: account.week?.gebruikt_pct ?? null,
                        week_reset: account.week?.reset ?? null, bron: account.bron,
                        reset_tegoeden: Number.isInteger(credits?.count) ? credits.count : null,
                        reset_tegoeden_json: Array.isArray(credits?.items) ? JSON.stringify(credits.items) : null
                    };
                }).filter(row => row.laatst_gezien);
                worker.postMessage({ type: "bewaar", rows });
            } catch (error) { fail(error); }
        },
        verloop: (options = {}) => request({ type: "verloop", ...options }),
        verbruik: (options) => request({ type: "verbruik", ...options }),
        klussen: (options = {}) => request({ type: "klussen", ...options }),
        inname: (options) => request({ type: "inname", ...options }),
        async close() {
            if (!worker || disabled) { await stopping; return; }
            await request({ type: "close" });
            disabled = true;
            const closing = worker;
            worker = null;
            if (closing) stopping = closing.terminate().catch(() => {});
            await stopping;
        }
    };
}

export function createStore(config, secrets, { fetchImpl = fetch, cacheFile, historyFile, backupMap } = {}) {
    const db = secrets.dbUrl.replace(/\/$/, "");
    const url = sub => `${db}/profiles/${secrets.binId}/${sub}.json`;
    let cache = null; // { profiles, readAt }
    let lastRefreshAsk = 0;
    const history = createHistory(historyFile, config, backupMap);
    if (cacheFile) { try { cache = JSON.parse(fs.readFileSync(cacheFile, "utf8")); } catch (e) { cache = null; } }

    async function getJson(u, timeoutMs, headers = {}) {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), timeoutMs);
        try {
            const r = await fetchImpl(u, { signal: ctrl.signal, headers, cache: "no-store" });
            if (!r.ok) throw new Error("http " + r.status);
            return { body: await r.json(), etag: r.headers.get("etag") };
        } finally { clearTimeout(t); }
    }

    async function readProfiles() {
        const { body } = await getJson(url("status"), config.leestijd_ms ?? 1500);
        const profiles = {};
        for (const [pid, node] of Object.entries(body || {})) {
            if (node && node.data) { try { profiles[pid] = JSON.parse(decrypt(node.data, secrets.pairingKey)); } catch (e) { /* unreadable node */ } }
        }
        if (!Object.keys(profiles).length) throw new Error("no readable profiles");
        return profiles;
    }

    // Same request the dashboard's refresh button makes: meta.refreshRequested(At).
    // Only when meta decrypts to a real object, so a wrong key can never wipe it.
    async function askRefresh(now, minS = config.ververs_vraag_min_s ?? 120) {
        if (now - lastRefreshAsk < minS * 1000) return;
        lastRefreshAsk = now;
        try {
            const { body, etag } = await getJson(url("meta"), 3000, { "X-Firebase-ETag": "true" });
            if (!body || !body.data) return;
            const meta = JSON.parse(decrypt(body.data, secrets.pairingKey));
            if (!meta || typeof meta !== "object" || !Object.keys(meta).length) return;
            meta.refreshRequested = true; meta.refreshRequestedAt = now;
            await fetchImpl(url("meta"), {
                method: "PUT", headers: { "Content-Type": "application/json", ...(etag ? { "if-match": etag } : {}) },
                body: JSON.stringify({ data: encrypt(JSON.stringify(meta), secrets.pairingKey) })
            });
        } catch (e) { /* the next request asks again */ }
    }

    const newestOf = profiles => Math.max(0, ...buildUsage(profiles || {}, config, { now: Date.now(), readOk: true, readAt: Date.now() })
        .accounts.map(a => (a.laatst_gezien ? Date.parse(a.laatst_gezien) : 0)));

    // ?ververs=1 (een knop, zoals Ververs in de werklijst): nu meten en kort wachten op de nieuwe meting.
    // Alleen op die aanvraag; geen timer. Begrensd: hooguit ververs_wacht_s, lezen elke ververs_lees_ms.
    async function fresh(now) {
        let before = 0;
        try {
            cache = { profiles: await readProfiles(), readAt: Date.now() };
            history.record(cache);
            before = newestOf(cache.profiles);
        } catch (e) { return false; }
        await askRefresh(now, config.ververs_knop_min_s ?? 10);
        const until = Date.now() + (config.ververs_wacht_s ?? 15) * 1000;
        while (Date.now() < until) {
            await new Promise(r => setTimeout(r, config.ververs_lees_ms ?? 1500));
            try {
                const p = await readProfiles();
                cache = { profiles: p, readAt: Date.now() };
                history.record(cache);
                if (newestOf(p) > before) { if (cacheFile) { try { fs.writeFileSync(cacheFile, JSON.stringify(cache), { mode: 0o600 }); } catch (e) {} } return true; }
            } catch (e) { /* volgende ronde */ }
        }
        return false;
    }

    async function usage(now = Date.now(), { ververs = false } = {}) {
        let readOk = true, ververst = null;
        if (ververs) { ververst = await fresh(now); }
        else if (!cache || now - cache.readAt > (config.cache_s ?? 20) * 1000) {
            try {
                cache = { profiles: await readProfiles(), readAt: now };
                history.record(cache);
                if (cacheFile) { try { fs.writeFileSync(cacheFile, JSON.stringify(cache), { mode: 0o600 }); } catch (e) {} }
            } catch (e) { readOk = false; }
        }
        const result = buildUsage(cache ? cache.profiles : {}, config, { now, readOk, readAt: cache ? cache.readAt : now });
        if (!readOk) result.fout = cache ? "database niet bereikbaar; laatste bekende waarden" : "database niet bereikbaar; nog geen waarden";
        if (ververst !== null) result.ververst = ververst;
        const newest = Math.max(0, ...result.accounts.map(a => (a.laatst_gezien ? Date.parse(a.laatst_gezien) : 0)));
        if (readOk && now - newest > (config.ververs_na_min ?? 5) * 60000) askRefresh(now); // not awaited
        return result;
    }
    return { usage, verloop: history.verloop, verbruik: history.verbruik, klussen: history.klussen, inname: history.inname, close: history.close };
}

// ---------------------------------------------------------------------------
// HTTP

// Client address check: "127.0.0.1", "100.64.0.0/10" etc. (IPv4, also as ::ffff:a.b.c.d).
export function clientAllowed(remote, allowed) {
    if (!allowed || !allowed.length) return true;
    const ip = String(remote || "").replace(/^::ffff:/, "");
    if (ip === "::1") return allowed.includes("127.0.0.1") || allowed.includes("127.0.0.0/8");
    const num = s => s.split(".").reduce((n, p) => n * 256 + Number(p), 0);
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return false;
    return allowed.some(rule => {
        const [base, bits = "32"] = rule.split("/");
        const mask = Number(bits) === 0 ? 0 : 2 ** 32 - 2 ** (32 - Number(bits));
        return (num(ip) & mask) >>> 0 === (num(base) & mask) >>> 0;
    });
}

function tokenOk(header, token) {
    const m = /^Bearer\s+(.+)$/i.exec(header || "");
    if (!m) return false;
    const a = Buffer.from(m[1].trim()), b = Buffer.from(token);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Bounded streaming: Content-Length is only an early check, never trusted as a limit.
async function readInname(req) {
    const limit = 8 * 1024 * 1024;
    if (Number(req.headers["content-length"]) > limit) { req.resume(); return { status: 413 }; }
    const chunks = [];
    let size = 0;
    for await (const chunk of req.iterator({ destroyOnReturn: false })) {
        size += chunk.length;
        if (size > limit) { req.resume(); return { status: 413 }; }
        chunks.push(chunk);
    }
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { return { status: 400 }; }
    if (!body || !["berichten", "codex", "klussen"].includes(body.tabel)
        || !Array.isArray(body.rijen) || body.rijen.length < 1 || body.rijen.length > 5000
        || body.rijen.some(row => !row || typeof row !== "object" || Array.isArray(row)
            || typeof row.id !== "string" || !row.id.trim())
        || (body.positie !== undefined && (!Number.isSafeInteger(body.positie) || body.positie < 0))) return { status: 400 };
    return { body };
}

const isoTimestamp = value => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/i.test(value) && Number.isFinite(Date.parse(value));
const utcDay = value => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;

async function sendBackup(res, backupMap, send) {
    let entries;
    try { entries = await fs.promises.readdir(backupMap, { withFileTypes: true }); }
    catch (error) {
        if (!["ENOENT", "ENOTDIR"].includes(error.code)) throw error;
        entries = [];
    }
    const latest = entries.filter(e => e.isFile() && /^usage-\d{4}-\d{2}-\d{2}\.sqlite$/.test(e.name))
        .map(e => e.name).sort().at(-1);
    if (!latest) return send(404, { fout: "geen back-up" });
    const stream = fs.createReadStream(path.join(backupMap, latest));
    // Open before sending headers, so an unreadable file still gives a JSON error.
    await once(stream, "open");
    res.writeHead(200, { "Content-Type": "application/gzip", "Cache-Control": "no-store", "X-Backup-Datum": latest.slice(6, 16) });
    await pipeline(stream, createGzip(), res);
}

export function createServer({ config, token, store, innameFile = config.inname_bestand,
    backupMap = config.backup_map ?? DEFAULT_BACKUP_MAP, clock = () => Date.now() }) {
    let inname = { pcs: {} }, innameMtime = -Infinity;
    function reloadInname() {
        if (!innameFile) return;
        try {
            const mtime = fs.statSync(innameFile).mtimeMs;
            if (mtime > innameMtime) {
                inname = JSON.parse(fs.readFileSync(innameFile, "utf8"));
                innameMtime = mtime;
            }
        } catch { inname = { pcs: {} }; innameMtime = -Infinity; }
    }
    reloadInname();
    return http.createServer(async (req, res) => {
        const send = (code, obj) => {
            res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
            res.end(JSON.stringify(obj));
        };
        try {
            const u = new URL(req.url, "http://localhost");
            if (!clientAllowed(req.socket.remoteAddress, config.toegestaan)) return send(403, { fout: "niet vanaf dit adres" });
            if (!["GET", "POST"].includes(req.method)) return send(405, { fout: "alleen GET/POST" });
            if (req.method === "POST") {
                if (u.pathname !== "/v1/inname") return send(405, { fout: "POST alleen op /v1/inname" });
                reloadInname();
                const pc = pcVoorToken(req.headers.authorization, inname);
                if (!pc) return send(401, { fout: "token ontbreekt of klopt niet" });
                const { body, status } = await readInname(req);
                if (status) return send(status, { fout: status === 413 ? "body te groot" : "ongeldige inname" });
                const { tabel, rijen, positie = null } = body;
                const result = await store.inname?.({ tabel, pc, positie, rijen });
                if (!result || result.fout) return send(503, { fout: "historie niet beschikbaar" });
                if (result.ongeldig) return send(400, { fout: "ongeldige inname" });
                return send(200, { ok: true, tabel, ontvangen: rijen.length, nieuw: result.nieuw, positie, backup: result.backup });
            }
            if (!tokenOk(req.headers.authorization, token)) return send(401, { fout: "token ontbreekt of klopt niet" });
            const now = clock();
            if (u.pathname === "/v1/usage") return send(200, await store.usage(now, { ververs: u.searchParams.get("ververs") === "1" }));
            if (u.pathname === "/v1/backup") return await sendBackup(res, backupMap, send);
            if (u.pathname === "/v1/verbruik") {
                const tot = u.searchParams.get("tot") ?? new Date(now).toISOString().slice(0, 10);
                if (!utcDay(tot)) return send(400, { fout: "van en tot moeten geldige UTC-dagen zijn (JJJJ-MM-DD)" });
                const van = u.searchParams.get("van") ?? new Date(Date.parse(tot) - 6 * 86400e3).toISOString().slice(0, 10);
                if (!utcDay(van) || van > tot || (Date.parse(tot) - Date.parse(van)) / 86400e3 >= 400) {
                    return send(400, { fout: "ongeldige periode; gebruik UTC-dagen en maximaal 400 dagen inclusief" });
                }
                const groep = [...new Set((u.searchParams.get("groep") ?? "dag,account").split(","))];
                if (groep.some(field => !["dag", "account", "model", "klus"].includes(field))) return send(400, { fout: "groep moet dag, account, model of klus bevatten" });
                const bron = u.searchParams.get("bron");
                if (bron !== null && !["claude", "codex"].includes(bron)) return send(400, { fout: "bron moet claude of codex zijn" });
                const result = await store.verbruik({ van, tot, groep, bron });
                if (result.fout) return send(503, { fout: "historie niet beschikbaar" });
                return send(200, { van, tot, groep, rijen: result.rijen });
            }
            if (u.pathname === "/v1/klussen") {
                const since = u.searchParams.get("sinds");
                const limit = u.searchParams.get("max");
                const max = limit === null ? 100 : Number(limit);
                if (limit !== null && (!/^\d+$/.test(limit) || !Number.isSafeInteger(max) || max < 1 || max > 1000)) return send(400, { fout: "max moet een geheel getal van 1 tot 1000 zijn" });
                if (since !== null && (!isoTimestamp(since) || !utcDay(since.slice(0, 10)))) return send(400, { fout: "sinds moet een ISO-tijdstip met tijdzone zijn" });
                const result = await store.klussen({ sinds: since === null ? null : new Date(since).toISOString(), max });
                if (result.fout) return send(503, { fout: "historie niet beschikbaar" });
                return send(200, result);
            }
            if (u.pathname === "/v1/verloop") {
                const account = u.searchParams.get("account");
                const since = u.searchParams.get("sinds");
                const limit = u.searchParams.get("max");
                const max = limit === null ? 500 : Number(limit);
                if (limit !== null && (!/^\d+$/.test(limit) || !Number.isSafeInteger(max) || max < 1)) return send(400, { fout: "max moet een positief geheel getal zijn" });
                if (since !== null && !isoTimestamp(since)) return send(400, { fout: "sinds moet een ISO-tijdstip met tijdzone zijn" });
                return send(200, await store.verloop({ account, sinds: since === null ? null : new Date(since).toISOString(), max, bron: u.searchParams.get("bron") }));
            }
            return send(404, { fout: "onbekend pad; gebruik /v1/usage, /v1/verloop, /v1/verbruik, /v1/klussen, /v1/backup, POST /v1/inname" });
        } catch (e) {
            if (res.headersSent) res.destroy();
            else if (!res.destroyed) send(500, { fout: "interne fout" });
        }
    });
}

export function loadAll(configPath = DEFAULT_CONFIG_PATH) {
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    const dir = path.dirname(configPath);
    const resolve = p => (path.isAbsolute(p) ? p : path.join(dir, p));
    const secrets = JSON.parse(fs.readFileSync(resolve(config.sync_bestand || "sync.json"), "utf8"));
    const token = fs.readFileSync(resolve(config.token_bestand || "token"), "utf8").trim();
    return {
        config, secrets, token, cacheFile: resolve(config.cache_bestand || "cache.json"),
        historyFile: resolve(config.historie_bestand || "historie.sqlite"),
        backupMap: config.backup_map ? resolve(config.backup_map) : DEFAULT_BACKUP_MAP,
        innameFile: resolve(config.inname_bestand || "inname.json")
    };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
    const { config, secrets, token, cacheFile, historyFile, backupMap, innameFile } = loadAll();
    const store = createStore(config, secrets, { cacheFile, historyFile, backupMap });
    // One listener; with 0.0.0.0 the toegestaan list limits clients (loopback + tailnet), so
    // the service does not depend on Tailscale being up before it starts.
    const host = config.adres || "127.0.0.1", port = config.poort || 8787;
    createServer({ config, token, store, innameFile, backupMap }).listen(port, host, () => console.log(`usage-api listening on http://${host}:${port}`));
    // Login links on request: one stream on meta (push); nothing runs without a request.
    const { loadProfielen } = await import("./profielen.mjs");
    if (loadProfielen().profielen.length) {
        const { createLoginService } = await import("./inlog.mjs");
        createLoginService(config, secrets).startStream({ onState: st => console.log(`login stream ${st}`) });
    }
}
