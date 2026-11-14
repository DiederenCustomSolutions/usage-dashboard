#!/usr/bin/env node
// usage-gebruiker-toevoegen <name> [--extern] [--min N]
// Adds a measuring user in one step: ports from the profile list, a Chrome of its own (unit
// chrome-usage@<name>, ALWAYS with --password-store=basic and its own debug port), pairing with the
// dashboard, and a login link as the last line of output. Exit codes: 2 bad name, 3 name taken, 1 other.
// The link is a tailnet link. Only with --extern the profile is marked extern and gets a public
// Tailscale Funnel link (see usage-inloglink); that is a deliberate choice per profile.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { NAAM_RE, defaultFile, loadProfielen, byName, pickFreePorts, addProfiel, removeProfiel, setField, syncEnv, confDir } from "./profielen.mjs";
import { readProfileId, provisionSync } from "./ext-cdp.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const sh = (cmd, args, opts = {}) => new Promise((res, rej) => execFile(cmd, args, { timeout: 60000, ...opts }, (e, out) => e ? rej(e) : res(String(out))));

export const MAX_PROFIELEN = 8;

export function parseArgs(argv) {
    const o = { naam: null, extern: false, min: 30 };
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === "--extern") o.extern = true;
        else if (argv[i] === "--min") o.min = Number(argv[++i]);
        else if (!o.naam && !argv[i].startsWith("-")) o.naam = argv[i];
        else return null;
    }
    return o.naam && o.min > 0 ? o : null;
}

// Waits until fn returns something (a startup wait with a limit, not a timer).
async function until(fn, tries, pause, sleepFn) {
    for (let i = 0; i < tries; i++) { try { const v = await fn(); if (v) return v; } catch {} await sleepFn(pause); }
    return null;
}

// deps: injected in tests. Returns the link line; throws Error with .code for the exit code.
export async function addUser(opts, { file = defaultFile(), run = sh, sleepFn = sleep, ext = { readProfileId, provisionSync },
    readSync = () => JSON.parse(fs.readFileSync(path.join(confDir(), "sync.json"), "utf8")), chromeDir = n => path.join(os.homedir(), ".config", `chrome-usage-${n}`),
    portsFor = pickFreePorts, log = console.error } = {}) {
    const fail = (code, msg) => Object.assign(new Error(msg), { code });
    const { naam } = opts;
    if (!NAAM_RE.test(naam)) throw fail(2, "name: letters, digits and '-', starting with a letter, 2-24 characters");
    const list = loadProfielen(file);
    if (byName(list, naam) || fs.existsSync(chromeDir(naam))) throw fail(3, "name already exists");
    if (list.profielen.length >= MAX_PROFIELEN) throw fail(1, `at most ${MAX_PROFIELEN} measuring profiles`);

    const ports = await portsFor(list);
    const label = naam.charAt(0).toUpperCase() + naam.slice(1);
    addProfiel(file, { naam, ports, extern: !!opts.extern, diensten: ["claude", "chatgpt"], label });
    const undo = async () => {
        await run("systemctl", ["--user", "disable", "--now", `chrome-usage@${naam}.service`]).catch(() => {});
        removeProfiel(file, naam);
        await sleepFn(2000);                                   // let Chrome let go of its folder; it did not exist before
        fs.rmSync(chromeDir(naam), { recursive: true, force: true });
    };
    try {
        syncEnv(loadProfielen(file), path.join(confDir(), "chrome-env"));
        log(`chrome for ${naam}: debug port ${ports.debugpoort}, --password-store=basic`);
        await run("systemctl", ["--user", "enable", "--now", `chrome-usage@${naam}.service`]);
        const up = await until(async () => (await fetch(`http://127.0.0.1:${ports.debugpoort}/json/version`)).ok, 30, 1000, sleepFn);
        if (!up) throw fail(1, "Chrome did not start");
        // Pairing + profile id from the extension of this Chrome (it needs a moment after the start).
        const sync = readSync();
        const done = await until(() => ext.provisionSync(ports.debugpoort, { binId: sync.binId, pairingKey: sync.pairingKey, label }), 30, 1000, sleepFn);
        if (done === null) log("extension not ready yet; the pairing is not set");
        const pid = await until(() => ext.readProfileId(ports.debugpoort), 10, 1000, sleepFn);
        if (pid) setField(file, naam, "pid", pid); else log("profile id not known yet; it is looked up at the first login request");
    } catch (e) { await undo(); throw e; }
    const out = await run(path.join(HERE, "usage-inloglink"), [naam, String(opts.min)]);
    return out.trim().split("\n").pop();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
    const o = parseArgs(process.argv.slice(2));
    if (!o) { console.error("Usage: usage-gebruiker-toevoegen <name> [--extern] [--min N]"); process.exit(2); }
    try { console.log(await addUser(o)); }
    catch (e) { console.error(e.message); process.exit(e.code === 2 || e.code === 3 ? e.code : 1); }
}
