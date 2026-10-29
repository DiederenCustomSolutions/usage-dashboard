// Usage read service for AI agents (v0.32.0).
// GET /v1/usage, read-only, Bearer token. Which account an agent takes is decided
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

const HOME = os.homedir();
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

export function createStore(config, secrets, { fetchImpl = fetch, cacheFile } = {}) {
    const db = secrets.dbUrl.replace(/\/$/, "");
    const url = sub => `${db}/profiles/${secrets.binId}/${sub}.json`;
    let cache = null; // { profiles, readAt }
    let lastRefreshAsk = 0;
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
    async function askRefresh(now) {
        if (now - lastRefreshAsk < (config.ververs_vraag_min_s ?? 120) * 1000) return;
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

    async function usage(now = Date.now()) {
        let readOk = true;
        if (!cache || now - cache.readAt > (config.cache_s ?? 20) * 1000) {
            try {
                cache = { profiles: await readProfiles(), readAt: now };
                if (cacheFile) { try { fs.writeFileSync(cacheFile, JSON.stringify(cache), { mode: 0o600 }); } catch (e) {} }
            } catch (e) { readOk = false; }
        }
        const result = buildUsage(cache ? cache.profiles : {}, config, { now, readOk, readAt: cache ? cache.readAt : now });
        if (!readOk) result.fout = cache ? "database niet bereikbaar; laatste bekende waarden" : "database niet bereikbaar; nog geen waarden";
        const newest = Math.max(0, ...result.accounts.map(a => (a.laatst_gezien ? Date.parse(a.laatst_gezien) : 0)));
        if (readOk && now - newest > (config.ververs_na_min ?? 5) * 60000) askRefresh(now); // not awaited
        return result;
    }
    return { usage };
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

export function createServer({ config, token, store, clock = () => Date.now() }) {
    return http.createServer(async (req, res) => {
        const send = (code, obj) => {
            res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
            res.end(JSON.stringify(obj));
        };
        try {
            const u = new URL(req.url, "http://localhost");
            if (!clientAllowed(req.socket.remoteAddress, config.toegestaan)) return send(403, { fout: "niet vanaf dit adres" });
            if (req.method !== "GET") return send(405, { fout: "alleen GET" });
            if (!tokenOk(req.headers.authorization, token)) return send(401, { fout: "token ontbreekt of klopt niet" });
            const now = clock();
            if (u.pathname === "/v1/usage") return send(200, await store.usage(now));
            return send(404, { fout: "onbekend pad; gebruik /v1/usage" });
        } catch (e) {
            send(500, { fout: "interne fout" });
        }
    });
}

export function loadAll(configPath = DEFAULT_CONFIG_PATH) {
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    const dir = path.dirname(configPath);
    const resolve = p => (path.isAbsolute(p) ? p : path.join(dir, p));
    const secrets = JSON.parse(fs.readFileSync(resolve(config.sync_bestand || "sync.json"), "utf8"));
    const token = fs.readFileSync(resolve(config.token_bestand || "token"), "utf8").trim();
    return { config, secrets, token, cacheFile: resolve(config.cache_bestand || "cache.json") };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
    const { config, secrets, token, cacheFile } = loadAll();
    const store = createStore(config, secrets, { cacheFile });
    // One listener; with 0.0.0.0 the toegestaan list limits clients (loopback + tailnet), so
    // the service does not depend on Tailscale being up before it starts.
    const host = config.adres || "127.0.0.1", port = config.poort || 8787;
    createServer({ config, token, store }).listen(port, host, () => console.log(`usage-api listening on http://${host}:${port}`));
}
