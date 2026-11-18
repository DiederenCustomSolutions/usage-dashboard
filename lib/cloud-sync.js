// Shared by the dashboard page and the extension's classic service worker.
const CLOUD_FETCH_TIMEOUT_MS = 15000;

async function cloudFetch(url, options, handleResponse = response => response) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CLOUD_FETCH_TIMEOUT_MS);
    try {
        const response = await fetch(url, { ...options, signal: controller.signal });
        return await handleResponse(response);
    } catch (error) {
        if (controller.signal.aborted) throw new Error("Cloud request timed out after 15 s", { cause: error });
        throw error;
    } finally {
        clearTimeout(timeout);
    }
}

function cs2NewerSyncStatus(current, incoming) {
    const merged = { ...incoming };
    for (const [provider, previous] of Object.entries(current || {})) {
        const next = merged[provider];
        if (previous && (!next || (previous.lastSynced || 0) > (next.lastSynced || 0))) {
            merged[provider] = previous;
        }
    }
    return merged;
}

function cs2LegacyBlobMutator(profileId, profileLabel, syncStatus) {
    return (doc) => {
        const profile = doc.profiles?.[profileId];
        // The oldest single-profile documents stored the measurement at the root.
        const previous = doc.profiles ? profile?.syncStatus : doc.syncStatus;
        const merged = cs2NewerSyncStatus(previous, syncStatus);
        doc.profiles ||= {};
        doc.profiles[profileId] = { ...profile, label: profileLabel, syncStatus: merged, lastSeen: Date.now() };
        doc.syncStatus = merged;
        doc.refreshRequested = false;
        doc.refreshRequestedAt = null;
        return doc;
    };
}

function decodeCloudDocument(raw, config) {
    // Creating a Firebase bin writes { data: ciphertext } at its root, so /data.json returns the string itself.
    const encrypted = typeof raw === "string" ? raw : raw?.data;
    if (typeof encrypted !== "string" || !encrypted) throw new Error("Missing encrypted cloud document");
    const doc = JSON.parse(CryptoSync.decrypt(encrypted, config.pairingKey));
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw new Error("Invalid cloud document");
    return doc;
}

function encodeCloudDocument(doc, config) {
    return { data: CryptoSync.encrypt(JSON.stringify(doc), config.pairingKey) };
}

async function retryCloudUpdate(update, attempts) {
    for (let attempt = 1; ; attempt++) {
        try {
            return await update(attempt);
        } catch (error) {
            if (attempt >= attempts) throw error;
            await new Promise(resolve => setTimeout(resolve, 150 * attempt));
        }
    }
}

function cs2FetchEnc(config, sub, withEtag) {
    return cloudFetch(`${cs2Url(config.binId, sub)}?nocache=${Date.now()}`, {
        cache: "no-store",
        headers: withEtag ? { "X-Firebase-ETag": "true" } : undefined
    }, async response => {
        if (!response.ok) throw new Error(`cs2 read ${response.status}`);
        const raw = await response.json();
        const etag = withEtag ? response.headers.get("ETag") : null;
        return { obj: raw === null ? {} : decodeCloudDocument(raw, config), etag };
    });
}

function cs2ReadEnc(config, sub) {
    return cs2FetchEnc(config, sub, false).catch(() => ({ obj: {}, etag: null }));
}

function cs2WriteEnc(config, sub, doc, etag) {
    const headers = { "Content-Type": "application/json" };
    if (etag) headers["if-match"] = etag;
    return cloudFetch(cs2Url(config.binId, sub), {
        method: "PUT", headers, body: JSON.stringify(encodeCloudDocument(doc, config))
    }, response => {
        if (!response.ok) throw new Error(`cs2 write ${response.status}`);
    });
}

function cs2UpdateEnc(config, sub, mutator) {
    const attempts = 5;
    return retryCloudUpdate(async (attempt) => {
        const { obj, etag } = await cs2FetchEnc(config, sub, true).catch(error => {
            // A browser can reject the preflight for X-Firebase-ETag.
            if (error.name !== "TypeError") throw error;
            return cs2FetchEnc(config, sub, false);
        });
        const updated = mutator(obj) || obj;
        try {
            // A hidden ETag leaves the merge intact and omits If-Match.
            await cs2WriteEnc(config, sub, updated, etag);
        } catch (error) {
            // Fetch also reports a blocked If-Match preflight as TypeError. Retry with
            // a fresh version first and fall back after repeated transport failures.
            if (!etag || error.name !== "TypeError" || attempt < attempts) throw error;
            const { obj: fresh } = await cs2FetchEnc(config, sub, false);
            await cs2WriteEnc(config, sub, mutator(fresh) || fresh);
        }
    }, attempts);
}

// Archives are complete snapshots and use a plain PUT.
function cs2PutEnc(config, sub, doc) {
    return cs2WriteEnc(config, sub, doc);
}

async function logFirebaseUpload(writes, scope, profileLabel) {
    const parts = Object.keys(writes);
    const results = await Promise.allSettled(Object.values(writes));
    const successes = results.filter(result => result.status === "fulfilled").length;
    const details = results.map((result, index) => {
        const outcome = result.status === "fulfilled" ? "ok" : `mislukt (${result.reason?.message || result.reason})`;
        return `${parts[index]}: ${outcome}`;
    });
    const summary = successes === parts.length ? "ok" : successes ? "gedeeltelijk gelukt" : "mislukt";
    logSync(`[${scope}${successes ? "" : " FOUT"}] V2 upload ${summary} (profile: ${profileLabel}) | ${details.join(" | ")}`);
}

// npoint has no version checks, so concurrent writers can overwrite each other's changes even after a fresh read and merge.
function updateNpointDocument(config, mutator) {
    const relay = syncRelay(config);
    return retryCloudUpdate(async () => {
        const doc = decodeCloudDocument(await relay.read(config.binId, 1), config);
        return relay.write(config.binId, encodeCloudDocument(mutator(doc) || doc, config));
    }, 3);
}

function updateNpointProfile(config, profileId, profileLabel, syncStatus, { logs, threads, settings }) {
    const updateProfile = cs2LegacyBlobMutator(profileId, profileLabel, syncStatus);
    return updateNpointDocument(config, (doc) => {
        updateProfile(doc);
        doc.logs = logs || [];
        doc.threads = threads || [];
        doc.settings = settings || {};
    });
}
