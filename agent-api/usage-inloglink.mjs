#!/usr/bin/env node
// Login link for one measuring Chrome on the agents-pc (Rob, 10-11-2026).
// Shows only a login tab of that Chrome in the browser (screencast over DevTools), mouse and keys go back.
// Tailnet only (binds to the tailscale0 address), secret token in the URL, stops by itself.
// Start with ~/bin/usage-inloglink <profiel>; never logs what is typed.
import http from "node:http";
import crypto from "node:crypto";
import os from "node:os";

const PROFIELEN = { rob: [9231, 8791], raimond: [9232, 8792], kevin: [9233, 8793], "kevin-lxdg": [9234, 8794] };
const SITES = { claude: "https://claude.ai/login", chatgpt: "https://chatgpt.com/auth/login" };
const profiel = process.argv[2];
const minuten = Number(process.argv[3] || 30);
const token = process.env.INLOG_TOKEN;
if (!PROFIELEN[profiel] || !token || token.length < 32) {
    console.error("Gebruik: INLOG_TOKEN=<geheim> usage-inloglink.mjs rob|raimond|kevin|kevin-lxdg [minuten]");
    process.exit(2);
}
const [cdpPort, webPort] = PROFIELEN[profiel];
const tsIp = (os.networkInterfaces().tailscale0 || []).find(a => a.family === "IPv4")?.address;
if (!tsIp) { console.error("geen tailscale0-adres"); process.exit(1); }
const W = 1200, H = 850;

// --- DevTools (one browser connection, flattened sessions) ---
const ver = await (await fetch(`http://127.0.0.1:${cdpPort}/json/version`)).json();
const ws = new WebSocket(ver.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("DevTools niet bereikbaar")); });
let nextId = 0;
const pending = new Map();
ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
        const { res, rej } = pending.get(m.id); pending.delete(m.id);
        m.error ? rej(new Error(m.error.message)) : res(m.result);
    } else onEvent(m);
};
ws.onclose = () => stop("DevTools-verbinding weg");
function send(method, params = {}, sessionId) {
    const id = ++nextId;
    ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
    return new Promise((res, rej) => pending.set(id, { res, rej }));
}

const eigen = new Set();          // tabs this link opened; closed again at the end
const stapel = [];                // [{targetId, sessionId}], last = shown (login popups on top)
let frame = null;
const kijkers = new Set();

async function toon(targetId) {
    const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
    const oud = stapel.at(-1);
    if (oud) send("Page.stopScreencast", {}, oud.sessionId).catch(() => {});
    stapel.push({ targetId, sessionId });
    await send("Page.enable", {}, sessionId);
    await send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false }, sessionId);
    await send("Page.startScreencast", { format: "jpeg", quality: 70, maxWidth: W, maxHeight: H }, sessionId);
}
async function terug() {
    stapel.pop();
    const t = stapel.at(-1);
    if (t) await send("Page.startScreencast", { format: "jpeg", quality: 70, maxWidth: W, maxHeight: H }, t.sessionId).catch(() => {});
}
function onEvent(m) {
    const actief = stapel.at(-1);
    if (m.method === "Page.screencastFrame") {
        send("Page.screencastFrameAck", { sessionId: m.params.sessionId }, m.sessionId).catch(() => {});
        if (!actief || m.sessionId !== actief.sessionId) return;
        frame = JSON.stringify({ img: m.params.data, w: m.params.metadata.deviceWidth, h: m.params.metadata.deviceHeight });
        for (const k of kijkers) k.write(`data: ${frame}\n\n`);
    } else if (m.method === "Target.targetCreated") {
        const t = m.params.targetInfo;
        if (t.type === "page" && actief && t.openerId === actief.targetId) { eigen.add(t.targetId); toon(t.targetId).catch(() => {}); }
    } else if (m.method === "Target.targetDestroyed") {
        eigen.delete(m.params.targetId);
        if (actief && m.params.targetId === actief.targetId) terug();
    }
}

// --- input ---
const VK = { Backspace: 8, Tab: 9, Enter: 13, Escape: 27, " ": 32, PageUp: 33, PageDown: 34, End: 35, Home: 36,
    ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Delete: 46 };
async function invoer(i) {
    const s = stapel.at(-1)?.sessionId;
    if (!s) return;
    if (i.t === "mouse") {
        await send("Input.dispatchMouseEvent", { type: i.type, x: i.x * W, y: i.y * H, button: i.button || "left",
            buttons: i.type === "mouseReleased" ? 0 : (i.down ? 1 : 0), clickCount: i.clickCount || 0, modifiers: i.mod || 0 }, s);
    } else if (i.t === "wheel") {
        await send("Input.dispatchMouseEvent", { type: "mouseWheel", x: i.x * W, y: i.y * H, deltaX: 0, deltaY: i.dy }, s);
    } else if (i.t === "key") {
        const printbaar = i.key.length === 1 && !(i.mod & 6);
        const vk = VK[i.key] ?? (i.key.length === 1 ? i.key.toUpperCase().charCodeAt(0) : 0);
        const tekst = printbaar ? i.key : i.key === "Enter" ? "\r" : undefined;
        await send("Input.dispatchKeyEvent", { type: tekst ? "keyDown" : "rawKeyDown", key: i.key, code: i.code,
            windowsVirtualKeyCode: vk, text: tekst, unmodifiedText: tekst, modifiers: i.mod || 0 }, s);
        await send("Input.dispatchKeyEvent", { type: "keyUp", key: i.key, code: i.code, windowsVirtualKeyCode: vk, modifiers: i.mod || 0 }, s);
    } else if (i.t === "text" && typeof i.text === "string") {
        await send("Input.insertText", { text: i.text.slice(0, 2000) }, s);
    } else if (i.t === "go" && SITES[i.site]) {
        while (stapel.length > 1) { const t = stapel.at(-1); await send("Target.closeTarget", { targetId: t.targetId }).catch(() => {}); stapel.pop(); }
        await send("Page.navigate", { url: SITES[i.site] }, stapel[0].sessionId);
    } else if (i.t === "stop") stop("klaar");
}

// --- web ---
const PAGINA = `<!doctype html><html lang="nl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Inloggen ${profiel}</title><style>
body{margin:0;font:14px system-ui,sans-serif;background:#1d1d1f;color:#eee}
header{display:flex;gap:8px;align-items:center;padding:8px 12px;flex-wrap:wrap}
button{font:inherit;padding:6px 12px;border-radius:6px;border:1px solid #555;background:#333;color:#eee;cursor:pointer}
#klaar{margin-left:auto;background:#2d6a3e}
#scherm{display:block;width:100%;max-width:${W}px;margin:0 auto;outline:none;cursor:default;touch-action:none}
#tijd{opacity:.7}</style></head><body>
<header><b>Meet-Chrome ${profiel}</b><button data-site="claude">Claude</button><button data-site="chatgpt">ChatGPT</button>
<span id="tijd"></span><button id="klaar">Klaar</button></header>
<img id="scherm" tabindex="0" alt="">
<script>
const basis=location.pathname.replace(/\\/$/,"");const img=document.getElementById("scherm");
const post=o=>fetch(basis+"/input",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(o)});
new EventSource(basis+"/frames").onmessage=e=>{const f=JSON.parse(e.data);img.src="data:image/jpeg;base64,"+f.img};
const eind=Date.now()+${minuten}*60000;setInterval(()=>{const m=Math.max(0,Math.ceil((eind-Date.now())/60000));document.getElementById("tijd").textContent="nog "+m+" min"},1000);
const pos=e=>{const r=img.getBoundingClientRect();return{x:(e.clientX-r.left)/r.width,y:(e.clientY-r.top)/r.height}};
const mod=e=>(e.altKey?1:0)|(e.ctrlKey?2:0)|(e.metaKey?4:0)|(e.shiftKey?8:0);
let neer=false,laatst=0;
img.addEventListener("pointerdown",e=>{img.focus();neer=true;post({t:"mouse",type:"mousePressed",...pos(e),clickCount:e.detail||1,down:true,mod:mod(e)});e.preventDefault()});
img.addEventListener("pointerup",e=>{neer=false;post({t:"mouse",type:"mouseReleased",...pos(e),clickCount:e.detail||1,mod:mod(e)})});
img.addEventListener("pointermove",e=>{const n=Date.now();if(n-laatst<60)return;laatst=n;post({t:"mouse",type:"mouseMoved",...pos(e),down:neer})});
img.addEventListener("wheel",e=>{post({t:"wheel",...pos(e),dy:e.deltaY});e.preventDefault()},{passive:false});
img.addEventListener("contextmenu",e=>e.preventDefault());
img.addEventListener("keydown",e=>{if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==="v")return;post({t:"key",key:e.key,code:e.code,mod:mod(e)});e.preventDefault()});
img.addEventListener("paste",e=>{post({t:"text",text:e.clipboardData.getData("text")});e.preventDefault()});
document.addEventListener("paste",e=>{if(document.activeElement!==img){post({t:"text",text:e.clipboardData.getData("text")})}});
document.querySelectorAll("[data-site]").forEach(b=>b.onclick=()=>{post({t:"go",site:b.dataset.site});img.focus()});
document.getElementById("klaar").onclick=()=>{post({t:"stop"});document.body.innerHTML="<p style=padding:16px>Gestopt.</p>"};
img.focus();
</script></body></html>`;

const server = http.createServer((req, res) => {
    const pad = req.url.split("?")[0];
    const juist = p => crypto.timingSafeEqual(Buffer.from(p.padEnd(200).slice(0, 200)), Buffer.from(`/${token}`.padEnd(200).slice(0, 200)));
    const [, tok, sub = ""] = pad.match(/^(\/[^/]*)\/?(.*)$/) || [];
    if (!tok || !juist(tok)) { res.writeHead(404).end(); return; }
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    if (req.method === "GET" && sub === "") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(PAGINA);
    } else if (req.method === "GET" && sub === "frames") {
        res.writeHead(200, { "Content-Type": "text/event-stream", Connection: "keep-alive" });
        if (frame) res.write(`data: ${frame}\n\n`);
        kijkers.add(res);
        req.on("close", () => kijkers.delete(res));
    } else if (req.method === "POST" && sub === "input") {
        let body = "";
        req.on("data", c => { body += c; if (body.length > 65536) req.destroy(); });
        req.on("end", () => {
            let i; try { i = JSON.parse(body); } catch { res.writeHead(400).end(); return; }
            invoer(i).then(() => res.writeHead(204).end(), () => res.writeHead(500).end());
        });
    } else res.writeHead(404).end();
});

let gestopt = false;
async function stop(reden) {
    if (gestopt) return; gestopt = true;
    console.log(`inloglink ${profiel} gestopt: ${reden}`);
    for (const k of kijkers) k.end();
    server.close();
    for (const id of eigen) await send("Target.closeTarget", { targetId: id }).catch(() => {});
    setTimeout(() => process.exit(0), 300);
}
process.on("SIGTERM", () => stop("SIGTERM"));
process.on("SIGINT", () => stop("SIGINT"));
setTimeout(() => stop(`${minuten} minuten voorbij`), minuten * 60000);

await send("Target.setDiscoverTargets", { discover: true });
const { targetId } = await send("Target.createTarget", { url: SITES[profiel.startsWith("kevin") ? "chatgpt" : "claude"] });
eigen.add(targetId);
await toon(targetId);
server.listen(webPort, tsIp, () => console.log(`inloglink ${profiel} actief op ${tsIp}:${webPort}, ${minuten} min`));
