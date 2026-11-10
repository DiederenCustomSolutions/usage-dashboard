// Talks to the Usage Dashboard extension of one measuring Chrome over its DevTools port
// (127.0.0.1 only). Used when a profile is added: read its profile id (pid) and, for a fresh
// profile, give it the pairing so it reports to the same dashboard. Never prints a key.
const EXT = "chrome-extension://dclbninbceiifmbadajdoljbjcjfmloc/";

export async function evalInExtension(port, expression, { fetchImpl = fetch, WS = WebSocket } = {}) {
    const targets = await (await fetchImpl(`http://127.0.0.1:${port}/json/list`)).json();
    const sw = targets.find(t => t.type === "service_worker" && t.url.startsWith(EXT)) || targets.find(t => t.url.startsWith(EXT));
    if (!sw) throw new Error("extension not found on this Chrome");
    const ws = new WS(sw.webSocketDebuggerUrl);
    await new Promise((ok, fail) => { ws.onopen = ok; ws.onerror = () => fail(new Error("DevTools not reachable")); });
    try {
        ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }));
        const reply = await new Promise(ok => { ws.onmessage = m => { const d = JSON.parse(m.data); if (d.id === 1) ok(d); }; });
        if (reply.error || reply.result?.exceptionDetails) throw new Error("extension call failed");
        return reply.result?.result?.value;
    } finally { ws.close(); }
}

export async function readProfileId(port, deps) {
    const v = await evalInExtension(port, `new Promise(r => chrome.storage.local.get(["lt_profile_id"], x => r(x.lt_profile_id || "")))`, deps);
    return /^pid-[a-z0-9-]+$/.test(v || "") ? v : null;
}

// Sets the pairing and the label only when the profile has none yet; an existing pairing is never overwritten.
export async function provisionSync(port, { binId, pairingKey, label }, deps) {
    const arg = JSON.stringify({ binId, pairingKey, label });
    const expression = `new Promise(r => chrome.storage.local.get(["lt_sync_config", "lt_profile_label"], x => {
        const a = ${arg}, set = {};
        if (!x.lt_sync_config || !x.lt_sync_config.binId) set.lt_sync_config = { provider: "firebase", binId: a.binId, pairingKey: a.pairingKey };
        if (!x.lt_profile_label && a.label) set.lt_profile_label = a.label;
        chrome.storage.local.set(set, () => r(Object.keys(set).join(",") || "kept"));
    }))`;
    return evalInExtension(port, expression, deps);
}
