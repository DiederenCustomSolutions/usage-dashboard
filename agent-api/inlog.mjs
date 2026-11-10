// Login links on request (v0.34.0). A dashboard tile of a logged-out account writes
// meta.loginRequests[<pid>] = { at }; this service sees it through ONE open stream on meta
// (push, no timer, no polling), starts usage-inloglink for that profile's measuring Chrome
// and writes meta.loginLinks[<pid>] = { url, at, until } back. All encrypted with the pairing
// key like the rest of meta. The link only works inside the tailnet. Never logs the link.
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decrypt, encrypt } from "./server.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const LINK_RE = /^http:\/\/[A-Za-z0-9.-]+:\d+\/[0-9a-f]{32,}$/;

// Runs `usage-inloglink <name> <min>`; the link is its last output line.
export function runInlogLink(name, minutes, { command = path.join(HERE, "usage-inloglink"), exec = execFile } = {}) {
    return new Promise((resolve, reject) => {
        exec(command, [name, String(minutes)], { timeout: 30000 }, (err, stdout) => {
            const url = String(stdout || "").trim().split("\n").pop();
            if (err || !LINK_RE.test(url)) return reject(new Error("inloglink failed"));
            resolve(url);
        });
    });
}

export function createLoginService(config, secrets, { fetchImpl = fetch, run = runInlogLink, clock = () => Date.now() } = {}) {
    const db = secrets.dbUrl.replace(/\/$/, "");
    const metaUrl = `${db}/profiles/${secrets.binId}/meta.json`;
    const names = config.inlog_profielen || {};
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
        const name = names[pid];
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

    // One pass over meta: handles every open request. Safe to call on every stream event.
    async function check() {
        if (busy) { again = true; return; }
        busy = true;
        try {
            do {
                again = false;
                const cur = await readMeta().catch(() => null);
                const reqs = Object.entries((cur && cur.meta.loginRequests) || {});
                for (const [pid, req] of reqs) {
                    if (!req || typeof req.at !== "number") continue;
                    if (clock() - req.at > maxAgeMs) {      // stale (e.g. from before a restart): drop it
                        await update(m => { if (m.loginRequests) delete m.loginRequests[pid]; }).catch(() => {});
                        continue;
                    }
                    await handle(pid, req).catch(() => {});
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
