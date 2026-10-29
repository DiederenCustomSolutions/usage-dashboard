// Copies the dashboard's database id and pairing key from a running measuring Chrome
// (DevTools port, localhost only) into a 0600 file. Prints nothing secret.
// Usage: node read-sync-key.mjs <cdp-port> <out-file>
import fs from "node:fs";

const [port = "9233", out] = process.argv.slice(2);
if (!out) { console.error("usage: node read-sync-key.mjs <cdp-port> <out-file>"); process.exit(2); }
const EXT = "chrome-extension://dclbninbceiifmbadajdoljbjcjfmloc/";

const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const sw = targets.find(t => t.type === "service_worker" && t.url.startsWith(EXT)) || targets.find(t => t.url.startsWith(EXT));
if (!sw) { console.error("extension not found on this Chrome"); process.exit(1); }

const ws = new WebSocket(sw.webSocketDebuggerUrl);
await new Promise((ok, fail) => { ws.onopen = ok; ws.onerror = fail; });
const expression = `new Promise(r => chrome.storage.local.get(["lt_sync_config"], x => { const c = x.lt_sync_config || {};
  r(JSON.stringify({ dbUrl: typeof FIREBASE_DB_URL === "string" ? FIREBASE_DB_URL : "https://usage-dashboard-98f1d-default-rtdb.europe-west1.firebasedatabase.app",
    provider: c.provider, binId: c.binId, pairingKey: c.pairingKey })); }))`;
ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }));
const reply = await new Promise(ok => { ws.onmessage = m => { const d = JSON.parse(m.data); if (d.id === 1) ok(d); }; });
ws.close();

const v = JSON.parse(reply.result?.result?.value || "{}");
if (v.provider !== "firebase" || !v.binId || !v.pairingKey) { console.error("no firebase sync config in this Chrome"); process.exit(1); }
fs.writeFileSync(out, JSON.stringify({ dbUrl: v.dbUrl, binId: v.binId, pairingKey: v.pairingKey }), { mode: 0o600 });
fs.chmodSync(out, 0o600);
console.log(`sync config written (bin ${v.binId.slice(0, 6)}…)`);
