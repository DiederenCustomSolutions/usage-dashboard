// Event-driven only: no timers, polling or Firebase access. SQLite failures
// disable history; the main thread continues serving usage independently.
import { parentPort, workerData } from "node:worker_threads";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";

// The order is also the canonical fingerprint order for a job snapshot.
const columns = {
    berichten: ["id", "tijd", "tijd_eind", "bron", "sessie_id", "titel", "project", "model", "input", "output", "cache_lees", "cache_schrijf_5m", "cache_schrijf_1u", "koud", "subagent", "prijs"],
    codex: ["id", "tijd", "account", "sessie_id", "werkmap", "model", "input", "cached_input", "output", "reasoning", "usd", "vijf_uur_pct", "week_pct"],
    klussen: ["id", "klusmap", "account", "model", "start", "eind", "week_voor", "week_na", "vijf_uur_voor", "vijf_uur_na", "input", "output", "usd", "pr", "exitcode", "gelukt", "status"]
};
const backupMap = workerData.backupMap ?? path.join(os.homedir(), ".local", "share", "usage-api", "backup");
const backupPattern = /^usage-(\d{4}-\d{2}-\d{2})\.sqlite$/;
let backup = null, attemptedDay = null;

function dailyBackup() {
    const now = new Date(), day = now.toISOString().slice(0, 10);
    if (attemptedDay === day) return;
    attemptedDay = day;
    try {
        fs.mkdirSync(backupMap, { recursive: true, mode: 0o700 });
        const target = path.join(backupMap, `usage-${day}.sqlite`);
        if (!fs.existsSync(target)) db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
        backup = day;
        for (const entry of fs.readdirSync(backupMap, { withFileTypes: true })) {
            if (!entry.isFile() || !backupPattern.test(entry.name)) continue;
            const file = path.join(backupMap, entry.name);
            if (fs.statSync(file).mtimeMs < now.getTime() - 14 * 86400e3) fs.unlinkSync(file);
        }
    } catch {
        // The HTTP worker forwards this fixed, single-line diagnostic. No payloads.
        parentPort.postMessage({ waarschuwing: "usage-api: dagelijkse back-up mislukt" });
    }
}

let db;
function fail() {
    parentPort.postMessage({ fout: "historieworker niet beschikbaar" });
    try { db?.close(); } catch { /* already unusable */ }
    parentPort.close();
}

try {
    const { DatabaseSync } = await import("node:sqlite");
    db = new DatabaseSync(workerData.bestand, { timeout: 0 });
    db.function("klusnaam", { deterministic: true }, werkmap => werkmap === null ? null
        : String(werkmap).replace(/[\\/]+$/, "").split(/[\\/]/).at(-1));
    db.exec(`
        CREATE TABLE IF NOT EXISTS metingen (
            id INTEGER PRIMARY KEY,
            gelezen_op TEXT,
            account TEXT,
            dienst TEXT,
            laatst_gezien TEXT,
            vijf_uur_pct REAL,
            vijf_uur_reset TEXT,
            week_pct REAL,
            week_reset TEXT,
            bron TEXT,
            reset_tegoeden INTEGER,
            reset_tegoeden_json TEXT,
            UNIQUE(account, laatst_gezien)
        );
        CREATE TABLE IF NOT EXISTS berichten (
            id TEXT PRIMARY KEY, pc TEXT, tijd TEXT, tijd_eind TEXT, bron TEXT,
            sessie_id TEXT, titel TEXT, project TEXT, model TEXT, input INTEGER,
            output INTEGER, cache_lees INTEGER, cache_schrijf_5m INTEGER,
            cache_schrijf_1u INTEGER, koud INTEGER, subagent INTEGER, prijs REAL,
            ontvangen_op TEXT
        );
        CREATE INDEX IF NOT EXISTS berichten_tijd ON berichten(tijd);
        CREATE TABLE IF NOT EXISTS codex (
            id TEXT PRIMARY KEY, pc TEXT, tijd TEXT, account TEXT, sessie_id TEXT,
            werkmap TEXT, model TEXT, input INTEGER, cached_input INTEGER,
            output INTEGER, reasoning INTEGER, usd REAL, vijf_uur_pct REAL,
            week_pct REAL, ontvangen_op TEXT
        );
        CREATE INDEX IF NOT EXISTS codex_account_tijd ON codex(account, tijd);
        CREATE TABLE IF NOT EXISTS klussen (
            rij INTEGER PRIMARY KEY, vingerafdruk TEXT UNIQUE, pc TEXT, id TEXT,
            klusmap TEXT, account TEXT, model TEXT, start TEXT, eind TEXT,
            week_voor REAL, week_na REAL, vijf_uur_voor REAL, vijf_uur_na REAL,
            input INTEGER, output INTEGER, usd REAL, pr TEXT, exitcode INTEGER,
            gelukt INTEGER, status TEXT, ontvangen_op TEXT
        );
        CREATE TABLE IF NOT EXISTS inname_log (
            rij INTEGER PRIMARY KEY, pc TEXT, tabel TEXT, tijd TEXT,
            ontvangen INTEGER, nieuw INTEGER, positie INTEGER
        );
        PRAGMA user_version = 2;
    `);
    try {
        const dates = fs.readdirSync(backupMap, { withFileTypes: true })
            .filter(e => e.isFile()).map(e => backupPattern.exec(e.name)?.[1]).filter(Boolean).sort();
        backup = dates.at(-1) ?? null;
    } catch { /* No backups yet, or an unavailable backup directory. */ }
    const ingest = Object.fromEntries(Object.entries(columns).map(([table, fields]) => {
        const names = [...fields, "pc", "ontvangen_op", ...(table === "klussen" ? ["vingerafdruk"] : [])];
        return [table, db.prepare(`INSERT OR IGNORE INTO ${table} (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`)];
    }));
    const audit = db.prepare("INSERT OR IGNORE INTO inname_log (pc, tabel, tijd, ontvangen, nieuw, positie) VALUES (?, ?, ?, ?, ?, ?)");
    const previousCodex = db.prepare("SELECT vijf_uur_pct, week_pct FROM metingen WHERE account = ? AND bron = 'codex' AND laatst_gezien < ? ORDER BY laatst_gezien DESC LIMIT 1");
    const codexMeasurement = db.prepare(`INSERT OR IGNORE INTO metingen
        (gelezen_op, account, dienst, laatst_gezien, vijf_uur_pct, week_pct, bron)
        VALUES (?, ?, 'chatgpt', ?, ?, ?, 'codex')`);
    const insert = db.prepare(`
        INSERT OR IGNORE INTO metingen (
            gelezen_op, account, dienst, laatst_gezien, vijf_uur_pct,
            vijf_uur_reset, week_pct, week_reset, bron, reset_tegoeden, reset_tegoeden_json
        ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE NOT EXISTS (SELECT 1 FROM metingen WHERE account = ? AND laatst_gezien >= ? AND bron IS NOT 'codex')
    `);
    parentPort.on("message", message => {
        try {
            if (message.type === "bewaar") {
                db.exec("BEGIN");
                for (const row of message.rows) {
                    insert.run(row.gelezen_op, row.account, row.dienst, row.laatst_gezien,
                        row.vijf_uur_pct, row.vijf_uur_reset, row.week_pct, row.week_reset,
                        row.bron, row.reset_tegoeden, row.reset_tegoeden_json, row.account, row.laatst_gezien);
                }
                db.exec("COMMIT");
                dailyBackup();
            } else if (message.type === "inname") {
                const { tabel, pc, positie = null, rijen } = message;
                if (rijen.some(row => columns[tabel].some(key => row[key] !== null && typeof row[key] === "object"))) {
                    parentPort.postMessage({ id: message.id, result: { ongeldig: true } });
                    return;
                }
                const receivedAt = new Date().toISOString();
                const rows = tabel === "codex" ? [...rijen].sort((a, b) => String(a.tijd ?? "").localeCompare(String(b.tijd ?? ""))) : rijen;
                let nieuw = 0;
                db.exec("BEGIN");
                try {
                    for (const row of rows) {
                        const values = columns[tabel].map(key => row[key] ?? null);
                        const args = [...values.map(v => typeof v === "boolean" ? Number(v) : v), pc, receivedAt];
                        if (tabel === "klussen") args.push(createHash("sha256").update(JSON.stringify(values)).digest("hex"));
                        const changes = Number(ingest[tabel].run(...args).changes);
                        nieuw += changes;
                        if (tabel === "codex" && changes && (row.week_pct != null || row.vijf_uur_pct != null)) {
                            const five = row.vijf_uur_pct ?? null, week = row.week_pct ?? null;
                            const previous = previousCodex.get(row.account ?? null, row.tijd ?? null);
                            if (!previous || previous.vijf_uur_pct !== five || previous.week_pct !== week) {
                                codexMeasurement.run(receivedAt, row.account ?? null, row.tijd ?? null, five, week);
                            }
                        }
                    }
                    audit.run(pc, tabel, receivedAt, rijen.length, nieuw, positie);
                    db.exec("COMMIT");
                } catch (error) { db.exec("ROLLBACK"); throw error; }
                dailyBackup();
                parentPort.postMessage({ id: message.id, result: { nieuw, backup } });
            } else if (message.type === "verloop") {
                const { account = null, sinds = null, max = 500, bron = null } = message;
                const where = [], args = [];
                if (account !== null) { where.push("account = ?"); args.push(account); }
                if (sinds !== null) { where.push("laatst_gezien >= ?"); args.push(sinds); }
                if (bron !== null) { where.push("bron = ?"); args.push(bron); }
                const rows = db.prepare(`SELECT * FROM metingen ${where.length ? "WHERE " + where.join(" AND ") : ""}
                    ORDER BY laatst_gezien DESC, id DESC LIMIT ?`).all(...args, max);
                parentPort.postMessage({ id: message.id, result: { metingen: rows } });
            } else if (message.type === "verbruik") {
                const { van, tot, groep, bron = null, uurstart = null } = message;
                // Only fixed column names enter SQL; all filter values are bound.
                const fields = groep.filter(field => ["dag", "uur", "account", "model", "klus", "sessie"].includes(field));
                const group = [...fields, "bron"].join(", ");
                const extra = fields.includes("uur") || fields.includes("sessie");
                // uur: clock hour (UTC), or with uurstart the whole hours since that instant (an integer).
                const hour = uurstart === null ? "strftime('%Y-%m-%dT%H:00:00Z', tijd)"
                    : "((CAST(strftime('%s', tijd) AS INTEGER) - CAST(strftime('%s', ?) AS INTEGER) + 360000000) / 3600 - 100000)";
                const extras = [
                    ...(extra ? ["ROUND(COALESCE(SUM(CASE WHEN context > 150000 THEN usd ELSE 0 END), 0), 4) AS groot_usd",
                        "ROUND(COALESCE(SUM(CASE WHEN subagent THEN usd ELSE 0 END), 0), 4) AS subagent_usd"] : []),
                    ...(fields.includes("sessie") ? ["MAX(titel) AS titel", "MAX(project) AS project",
                        "MIN(tijd) AS eerste", "MAX(tijd) AS laatste"] : [])
                ];
                const rows = db.prepare(`WITH verbruik AS (
                    SELECT substr(tijd, 1, 10) AS dag, ${hour} AS uur, 'claude' AS account, model,
                        COALESCE(titel, project) AS klus, sessie_id AS sessie, titel, project, tijd, subagent,
                        COALESCE(input, 0) + COALESCE(cache_lees, 0) + COALESCE(cache_schrijf_5m, 0) + COALESCE(cache_schrijf_1u, 0) AS context,
                        'claude' AS bron, input, output, cache_lees,
                        COALESCE(cache_schrijf_5m, 0) + COALESCE(cache_schrijf_1u, 0) AS cache_schrijf, prijs AS usd
                    FROM berichten WHERE substr(tijd, 1, 10) BETWEEN ? AND ?
                    UNION ALL
                    SELECT substr(tijd, 1, 10) AS dag, ${hour} AS uur, account, model, klusnaam(werkmap) AS klus,
                        sessie_id AS sessie, NULL AS titel, NULL AS project, tijd, 0 AS subagent,
                        COALESCE(input, 0) AS context, 'codex' AS bron,
                        input, COALESCE(output, 0) + COALESCE(reasoning, 0) AS output, cached_input AS cache_lees,
                        0 AS cache_schrijf, usd
                    FROM codex WHERE substr(tijd, 1, 10) BETWEEN ? AND ?
                ) SELECT ${group}, COUNT(*) AS regels, COALESCE(SUM(input), 0) AS input,
                    COALESCE(SUM(output), 0) AS output, COALESCE(SUM(cache_lees), 0) AS cache_lees,
                    COALESCE(SUM(cache_schrijf), 0) AS cache_schrijf, ROUND(COALESCE(SUM(usd), 0), 4) AS usd${extras.map(e => ", " + e).join("")}
                FROM verbruik ${bron === null ? "" : "WHERE bron = ?"}
                GROUP BY ${group} ORDER BY ${group}`).all(
                    ...(uurstart === null ? [] : [uurstart]), van, tot,
                    ...(uurstart === null ? [] : [uurstart]), van, tot, ...(bron === null ? [] : [bron]));
                parentPort.postMessage({ id: message.id, result: { rijen: rows } });
            } else if (message.type === "klussen") {
                const { sinds = null, max = 100 } = message;
                const rows = db.prepare(`SELECT id, pc, ${columns.klussen.slice(1).join(", ")} FROM klussen
                    WHERE rij IN (SELECT MAX(rij) FROM klussen GROUP BY id)
                    ${sinds === null ? "" : "AND julianday(start) >= julianday(?)"}
                    ORDER BY julianday(start) DESC, rij DESC LIMIT ?`).all(...(sinds === null ? [] : [sinds]), max);
                parentPort.postMessage({ id: message.id, result: { klussen: rows } });
            } else if (message.type === "close") {
                db.close();
                parentPort.postMessage({ id: message.id, result: null });
                parentPort.close();
            }
        } catch (error) { fail(error); }
    });
} catch (error) { fail(error); }
