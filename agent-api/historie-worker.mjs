// Event-driven only: no timers, polling or Firebase access. SQLite failures
// disable history; the main thread continues serving usage independently.
import { parentPort, workerData } from "node:worker_threads";

let db;
function fail(error) {
    parentPort.postMessage({ fout: String(error.message || error) });
    try { db?.close(); } catch { /* already unusable */ }
    parentPort.close();
}

try {
    const { DatabaseSync } = await import("node:sqlite");
    db = new DatabaseSync(workerData, { timeout: 0 });
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
        )
    `);
    const insert = db.prepare(`
        INSERT OR IGNORE INTO metingen (
            gelezen_op, account, dienst, laatst_gezien, vijf_uur_pct,
            vijf_uur_reset, week_pct, week_reset, bron, reset_tegoeden, reset_tegoeden_json
        ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE NOT EXISTS (SELECT 1 FROM metingen WHERE account = ? AND laatst_gezien >= ?)
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
            } else if (message.type === "verloop") {
                const { account = null, sinds = null, max = 500 } = message;
                const where = [], args = [];
                if (account !== null) { where.push("account = ?"); args.push(account); }
                if (sinds !== null) { where.push("laatst_gezien >= ?"); args.push(sinds); }
                const rows = db.prepare(`SELECT * FROM metingen ${where.length ? "WHERE " + where.join(" AND ") : ""}
                    ORDER BY laatst_gezien DESC, id DESC LIMIT ?`).all(...args, max);
                parentPort.postMessage({ id: message.id, result: { metingen: rows } });
            } else if (message.type === "close") {
                db.close();
                parentPort.postMessage({ id: message.id, result: null });
                parentPort.close();
            }
        } catch (error) { fail(error); }
    });
} catch (error) { fail(error); }
