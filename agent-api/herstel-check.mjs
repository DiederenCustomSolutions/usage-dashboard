#!/usr/bin/env node
// Exit 0 when every account was measured after <sinceMs>. Used by herstel-meetchromes.sh.
// The request itself is the trigger: on stale data the read service asks the Chromes to measure.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

export function allMeasuredSince(accounts, sinceMs) {
    return Array.isArray(accounts) && accounts.length > 0 &&
        accounts.every(a => a.laatst_gezien && Date.parse(a.laatst_gezien) >= sinceMs);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    const conf = path.join(os.homedir(), ".config/usage-api");
    const token = fs.readFileSync(path.join(conf, "token"), "utf8").trim();
    const { poort = 8787 } = JSON.parse(fs.readFileSync(path.join(conf, "config.json"), "utf8"));
    try {
        const r = await fetch(`http://127.0.0.1:${poort}/v1/usage`, {
            headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000)
        });
        const { accounts } = await r.json();
        process.exit(allMeasuredSince(accounts, Number(process.argv[2])) ? 0 : 1);
    } catch (e) { process.exit(1); }
}
