// Login links on request (v0.34.0). A dashboard tile of a logged-out account writes
// meta.loginRequests[<pid>] = { at }; this service sees it through ONE open stream on meta
// (push, no timer, no polling), starts usage-inloglink for that profile's measuring Chrome
// and writes meta.loginLinks[<pid>] = { url, at, until } back. All encrypted with the pairing
// key like the rest of meta. A tailnet link only works inside the tailnet; a profile marked extern
// gets a public Funnel link (https, see usage-inloglink). Never logs the link.
// v0.35.0: also meta.addRequests[<id>] = { name, at } ("Add measuring profile"): runs
// usage-gebruiker-toevoegen and answers in meta.addResults[<id>]. Names and pids come from
// profielen.json (profielen.mjs), not from config.
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decrypt, encrypt } from "./server.mjs";
import { loadProfielen, byPid, setField, defaultFile, NAAM_RE } from "./profielen.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const LINK_RE = /^https?:\/\/[A-Za-z0-9.-]+(:\d+)?\/[0-9a-f]{32,}$/;

// Runs a command whose last output line is a login link. Rejects with the exit code, never with output.
export function runForLink(command, args, { exec = execFile, timeout = 30000 } = {}) {
    return new Promise((resolve, reject) => {
        exec(command, args, { timeout }, (err, stdout) => {
            const url = String(stdout || "").trim().split("\n").pop();
            if (err || !LINK_RE.test(url)) return reject(Object.assign(new Error("command failed"), { code: err && typeof err.code === "number" ? err.code : 1 }));
            resolve(url);
        });
    });
}
// `usage-inloglink <name> <min>`
export const runInlogLink = (name, minutes, { command = path.join(HERE, "usage-inloglink"), ...o } = {}) => runForLink(command, [name, String(minutes)], o);
// `usage-gebruiker-toevoegen <name> --min <min>`: starts a Chrome, so it may take a while.
export const runAddUser = (name, minutes, { command = path.join(HERE, "usage-gebruiker-toevoegen"), ...o } = {}) =>
    runForLink(command, [name, "--min", String(minutes)], { timeout: 150000, ...o });

// Profiles whose pid is not known yet (just added): ask their Chrome now, on demand.
export async function resolvePids(file = defaultFile()) {
    const { readProfileId } = await import("./ext-cdp.mjs");
    for (const p of loadProfielen(file).profielen.filter(p => !p.pid)) {
        const pid = await readProfileId(p.debugpoort).catch(() => null);
        if (pid) setField(file, p.naam, "pid", pid);
    }
}

export function createLoginService(config, secrets, { fetchImpl = fetch, run = runInlogLink, runAdd = runAddUser, clock = () => Date.now(),
    profielen = () => loadProfielen(), resolve = () => resolvePids() } = {}) {
    const db = secrets.dbUrl.replace(/\/$/, "");
    const metaUrl = `${db}/profiles/${secrets.binId}/meta.json`;
    const minutes = config.inlog_min ?? 30;
    const maxAgeMs = (config.inlog_verzoek_max_min ?? 5) * 60000;
    let busy = false, again = false;

    async function readMeta() {
        const r = await fetchImpl(metaUrl, { headers: { "X-Firebase-ETag": "true" }, cache: "no-store" });
        if (!r.ok) throw new Error("http " + r.status);
        const body = await r.json();
        if (!body || !body.data) return null;
        const meta = JSON.parse(decrypt(body.data, secrets.pairingKey));
        // Only a real object: a wrong key must never wipe meta.
        if (!meta || typeof meta !== "object" || !Object.keys(meta).length) return null;
        return { meta, etag: r.headers.get("etag") };
    }

    async function writeMeta(meta, etag) {
        const r = await fetchImpl(metaUrl, {
            method: "PUT", headers: { "Content-Type": "application/json", ...(etag ? { "if-match": etag } : {}) },
            body: JSON.stringify({ data: encrypt(JSON.stringify(meta), secrets.pairingKey) })
        });
        if (r.status === 412) return false;
        if (!r.ok) throw new Error("http " + r.status);
        return true;
    }

    // Read-modify-write on meta with the ETag, so other writers (extension, dashboard) are not overwritten.
    async function update(mutator, attempts = 4) {
        for (let i = 0; i < attempts; i++) {
            const cur = await readMeta();
            if (!cur) return false;
            mutator(cur.meta);
            if (await writeMeta(cur.meta, cur.etag)) return true;
        }
        return false;
    }

    async function handle(pid, req) {
        const now = clock();
        let p = byPid(profielen(), pid);
        if (!p) { await Promise.resolve(resolve()).catch(() => {}); p = byPid(profielen(), pid); }
        const name = p && p.naam;
        let link;
        if (!name) link = { error: "no measuring Chrome for this profile", at: now };
        else {
            try { link = { url: await run(name, minutes), at: now, until: now + minutes * 60000 }; }
            catch (e) { link = { error: "could not start the login link", at: now }; }
        }
        await update(m => {
            if (m.loginRequests && m.loginRequests[pid] && m.loginRequests[pid].at === req.at) delete m.loginRequests[pid];
            m.loginLinks = { ...(m.loginLinks || {}), [pid]: link };
        });
    }

    const ADD_ERRORS = { 2: "invalid name", 3: "name already exists" };
    async function handleAdd(id, req) {
        const now = clock();
        let result;
        if (typeof req.name !== "string" || !NAAM_RE.test(req.name)) result = { error: "invalid name", at: now };
        else {
            try {
                const url = await runAdd(req.name, minutes);
                const pub = url.startsWith("https:");
                result = { name: req.name, url, at: now, until: now + (pub ? Math.min(minutes, 60) : minutes) * 60000, public: pub };
            } catch (e) { result = { name: req.name, error: ADD_ERRORS[e && e.code] || "could not add the profile", at: now }; }
        }
        await update(m => {
            if (m.addRequests && m.addRequests[id] && m.addRequests[id].at === req.at) delete m.addRequests[id];
            const keep = Object.entries(m.addResults || {}).filter(([, r]) => r && now - r.at < 86400000);
            m.addResults = { ...Object.fromEntries(keep), [id]: result };
        });
    }

    // One pass over meta: handles every open request. Safe to call on every stream event.
    async function check() {
        if (busy) { again = true; return; }
        busy = true;
        try {
            do {
                again = false;
                const cur = await readMeta().catch(() => null);
                for (const [field, work] of [["loginRequests", handle], ["addRequests", handleAdd]]) {
                    for (const [key, req] of Object.entries((cur && cur.meta[field]) || {})) {
                        if (!req || typeof req.at !== "number") continue;
                        if (clock() - req.at > maxAgeMs) {      // stale (e.g. from before a restart): drop it
                            await update(m => { if (m[field]) delete m[field][key]; }).catch(() => {});
                            continue;
                        }
                        await work(key, req).catch(() => {});
                    }
                }
            } while (again);
        } finally { busy = false; }
    }

    // The one stream on meta. Reconnects with a growing pause after a drop; no other timer.
    function startStream({ onState } = {}) {
        const ctrl = new AbortController();
        (async () => {
            let pause = 2000;
            while (!ctrl.signal.aborted) {
                try {
                    const r = await fetchImpl(metaUrl, { headers: { Accept: "text/event-stream" }, signal: ctrl.signal });
                    if (!r.ok) throw new Error("http " + r.status);
                    pause = 2000;
                    if (onState) onState("connected");
                    const dec = new TextDecoder();
                    let buf = "";
                    for await (const chunk of r.body) {
                        buf += dec.decode(chunk, { stream: true });
                        let i;
                        while ((i = buf.indexOf("\n\n")) >= 0) {
                            const ev = buf.slice(0, i); buf = buf.slice(i + 2);
                            if (/^event:\s*(put|patch)/m.test(ev)) check().catch(() => {});
                        }
                    }
                } catch (e) { if (ctrl.signal.aborted) return; }
                if (onState) onState("reconnecting");
                await new Promise(res => setTimeout(res, pause));
                pause = Math.min(pause * 2, 60000);
            }
        })();
        return { close: () => ctrl.abort() };
    }

    return { check, startStream };
}
