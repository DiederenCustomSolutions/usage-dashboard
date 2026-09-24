/* Keeps one live connection (Server-Sent Events) to the shared meta node.
   A service worker cannot hold such a stream open, an offscreen document can.
   Every change to meta wakes the service worker, which decides whether a
   refresh was requested. The 30s alarm poll stays as a fallback. */
let source = null;
let watchedUrl = null;

function notifyChanged() {
    chrome.runtime.sendMessage({ type: "META_CHANGED" }).catch(() => {});
}

chrome.runtime.onMessage.addListener((message) => {
    if (message.type !== "META_WATCH") return;
    if (message.url === watchedUrl && source && source.readyState !== EventSource.CLOSED) return;
    if (source) source.close();
    watchedUrl = message.url;
    source = new EventSource(watchedUrl);
    source.addEventListener("put", notifyChanged);
    source.addEventListener("patch", notifyChanged);
    source.onerror = () => {};  // EventSource reconnects by itself
});
