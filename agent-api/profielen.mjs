// The one list of measuring profiles (v0.35.0): name, profile id (pid), services, ports.
// Everything that used to hard-code names and ports reads it: usage-inloglink, the repair and
// autoupdate scripts, the Chrome unit, the Kevin script and the login service.
//
// The live list is ~/.config/usage-api/profielen.json (outside git, so a new profile never blocks
// the autoupdate); without it, profielen.example.json next to this file is used.
//
// CLI (for the shell scripts):
//   node profielen.mjs names [unit|script]     one name per line
//   node profielen.mjs get <naam> <veld>       one field (debugpoort, webpoort, pid, start, extern, diensten)
//   node profielen.mjs set <naam> extern true|false
//   node profielen.mjs sync-env                writes ~/.config/usage-api/chrome-env/<naam>.env (DEBUG_PORT)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const NAAM_RE = /^[a-z][a-z0-9-]{1,23}$/;
export const DEBUG_START = 9231, WEB_START = 8791, POORT_MAX = 65000;

export const confDir = () => process.env.USAGE_API_DIR || path.join(os.homedir(), ".config", "usage-api");
export const defaultFile = () => process.env.USAGE_PROFIELEN || path.join(confDir(), "profielen.json");

export function loadProfielen(file = defaultFile()) {
    for (const f of [file, path.join(HERE, "profielen.example.json")]) {
        try { return validate(JSON.parse(fs.readFileSync(f, "utf8"))); } catch (e) { if (e.code !== "ENOENT") throw e; }
    }
    throw new Error("no profielen.json");
}

export function validate(list) {
    if (!list || !Array.isArray(list.profielen)) throw new Error("profielen.json: 'profielen' must be a list");
    const names = new Set(), ports = new Set();
    for (const p of list.profielen) {
        if (!NAAM_RE.test(p.naam || "")) throw new Error(`profielen.json: bad name ${JSON.stringify(p.naam)}`);
        if (names.has(p.naam)) throw new Error(`profielen.json: double name ${p.naam}`);
        names.add(p.naam);
        for (const k of ["debugpoort", "webpoort"]) {
            if (!Number.isInteger(p[k]) || p[k] < 1024 || p[k] > POORT_MAX) throw new Error(`profielen.json: ${p.naam}.${k}`);
            if (ports.has(p[k])) throw new Error(`profielen.json: double port ${p[k]}`);
            ports.add(p[k]);
        }
        if (!["unit", "script"].includes(p.start)) throw new Error(`profielen.json: ${p.naam}.start`);
    }
    return list;
}

export const byName = (list, naam) => list.profielen.find(p => p.naam === naam);
export const byPid = (list, pid) => list.profielen.find(p => p.pid && p.pid === pid);
// pid -> name, for the profiles whose pid is known.
export const pidMap = list => Object.fromEntries(list.profielen.filter(p => p.pid).map(p => [p.pid, p.naam]));

// First free port numbers from the starting points up; `used` are ports of the list (and anything else taken).
export function pickPorts(list, taken = []) {
    const used = new Set([...taken, ...list.profielen.flatMap(p => [p.debugpoort, p.webpoort])]);
    const next = from => { let n = from; while (used.has(n)) n++; used.add(n); return n; };
    return { debugpoort: next(DEBUG_START), webpoort: next(WEB_START) };
}

export const portFree = port => new Promise(res => {
    const s = net.createServer();
    s.once("error", () => res(false));
    s.listen(port, "127.0.0.1", () => s.close(() => res(true)));
});

export async function pickFreePorts(list) {
    const taken = [];
    for (;;) {
        const p = pickPorts(list, taken);
        const bad = [];
        if (!(await portFree(p.debugpoort))) bad.push(p.debugpoort);
        if (!(await portFree(p.webpoort))) bad.push(p.webpoort);
        if (!bad.length) return p;
        taken.push(...bad);
    }
}

// Writes go through a lock file and an atomic rename; the file is 0600 like the other config.
export function mutate(file, fn) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const lock = file + ".lock";
    let fd;
    for (let i = 0; ; i++) {
        try { fd = fs.openSync(lock, "wx"); break; }
        catch (e) {
            if (e.code !== "EEXIST") throw e;
            try { if (Date.now() - fs.statSync(lock).mtimeMs > 30000) fs.unlinkSync(lock); } catch {}   // stale lock
            if (i > 100) throw new Error("profielen.json is locked");
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
        }
    }
    try {
        const list = structuredClone(loadProfielen(file));
        const out = fn(list) || list;
        validate(out);
        const tmp = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(out, null, 2) + "\n", { mode: 0o600 });
        fs.renameSync(tmp, file);
        return out;
    } finally { fs.closeSync(fd); try { fs.unlinkSync(lock); } catch {} }
}

export function addProfiel(file, { naam, ports, extern = true, diensten = ["claude", "chatgpt"], label }) {
    let added;
    mutate(file, list => {
        if (byName(list, naam)) { const e = new Error("name exists"); e.code = "EXISTS"; throw e; }
        added = { naam, pid: null, diensten, start: "unit", ...ports, extern, ...(label ? { label } : {}) };
        list.profielen.push(added);
    });
    return added;
}
export const removeProfiel = (file, naam) => mutate(file, list => { list.profielen = list.profielen.filter(p => p.naam !== naam); });
export const setField = (file, naam, field, value) => mutate(file, list => {
    const p = byName(list, naam);
    if (!p) throw new Error("unknown profile");
    p[field] = value;
});

// systemd reads DEBUG_PORT for chrome-usage@<naam> from here (replaces the debugpoort.conf drop-ins).
export function syncEnv(list, dir = path.join(confDir(), "chrome-env")) {
    fs.mkdirSync(dir, { recursive: true });
    for (const p of list.profielen.filter(p => p.start === "unit")) fs.writeFileSync(path.join(dir, `${p.naam}.env`), `DEBUG_PORT=${p.debugpoort}\n`);
}

// The site the login link opens first.
export const startSite = p => (p.diensten && p.diensten[0]) || "claude";

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
    const [cmd, a, b, c] = process.argv.slice(2);
    try {
        const file = defaultFile(), list = loadProfielen(file);
        if (cmd === "names") console.log(list.profielen.filter(p => !a || p.start === a).map(p => p.naam).join("\n"));
        else if (cmd === "get") {
            const p = byName(list, a);
            if (!p || !(b in p)) { console.error("unknown profile or field"); process.exit(1); }
            console.log(Array.isArray(p[b]) ? p[b].join(",") : String(p[b]));
        } else if (cmd === "set" && b === "extern" && ["true", "false"].includes(c)) { setField(file, a, b, c === "true"); }
        else if (cmd === "sync-env") syncEnv(list);
        else { console.error("usage: profielen.mjs names [unit|script] | get <naam> <veld> | set <naam> extern true|false | sync-env"); process.exit(2); }
    } catch (e) { console.error(e.message); process.exit(1); }
}
