// Shared by the dashboard page and the extension's classic service worker.
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
    if (!raw?.data) throw new Error("Missing encrypted cloud document");
    const doc = JSON.parse(CryptoSync.decrypt(raw.data, config.pairingKey));
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw new Error("Invalid cloud document");
    return doc;
}

function encodeCloudDocument(doc, config) {
    return { data: CryptoSync.encrypt(JSON.stringify(doc), config.pairingKey) };
}

async function retryCloudUpdate(update, attempts) {
    for (let attempt = 1; ; attempt++) {
        try {
            return await update();
        } catch (error) {
            if (attempt >= attempts) throw error;
            await new Promise(resolve => setTimeout(resolve, 150 * attempt));
        }
    }
}

async function cs2ReadEnc(config, sub, forUpdate = false) {
    const response = await fetch(`${cs2Url(config.binId, sub)}?nocache=${Date.now()}`, {
        cache: "no-store",
        headers: forUpdate ? { "X-Firebase-ETag": "true" } : undefined
    });
    try {
        if (!response.ok) throw new Error(`cs2 read ${response.status}`);
        const etag = response.headers.get("ETag");
        if (forUpdate && !etag) throw new Error("Missing Firebase ETag");
        const raw = await response.json();
        return { obj: raw === null ? {} : decodeCloudDocument(raw, config), etag };
    } catch (error) {
        if (forUpdate) throw error;
        return { obj: {}, etag: null };
    }
}

async function cs2WriteEnc(config, sub, doc, etag) {
    const headers = { "Content-Type": "application/json" };
    if (etag) headers["if-match"] = etag;
    const response = await fetch(cs2Url(config.binId, sub), {
        method: "PUT", headers, body: JSON.stringify(encodeCloudDocument(doc, config))
    });
    if (!response.ok) throw new Error(`cs2 write ${response.status}`);
}

function cs2UpdateEnc(config, sub, mutator) {
    // Both conflicts and temporary transport failures restart with a fresh version.
    return retryCloudUpdate(async () => {
        const { obj, etag } = await cs2ReadEnc(config, sub, true);
        await cs2WriteEnc(config, sub, mutator(obj) || obj, etag);
    }, 5);
}

// Archives are complete snapshots and use a plain PUT.
function cs2PutEnc(config, sub, doc) {
    return cs2WriteEnc(config, sub, doc);
}

// npoint replaces the whole document and has no conditional update API.
function updateNpointDocument(config, mutator) {
    const relay = syncRelay(config);
    return retryCloudUpdate(async () => {
        const doc = decodeCloudDocument(await relay.read(config.binId), config);
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
