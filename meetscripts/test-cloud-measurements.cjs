// Real upload and reset functions with synthetic data and in-memory HTTP responses.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const app = read('app.js');
const background = read('background.js');
const sharedPath = 'lib/cloud-sync.js';
const shared = read(sharedPath);
const config = { enabled: true, provider: 'firebase', binId: 'test-bin', pairingKey: 'test-key' };

function extractFunction(source, name) {
    const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm'));
    const end = source.indexOf('\n}', start);
    assert.ok(start >= 0 && end > start, name);
    return source.slice(start, end + 2);
}

function createWriter(source, fetch, syncConfig = config) {
    const stored = { lt_sync_config: syncConfig, lt_profile_id: 'p1', lt_profile_label: 'One' };
    const paired = Promise.withResolvers();
    const storage = {
        get: (keys, callback) => callback(stored),
        set(values, callback) {
            Object.assign(stored, values);
            callback();
            paired.resolve(stored.lt_sync_config);
        }
    };
    const timers = new Map();
    const logs = [];
    const button = {};
    let uploaded;
    const ctx = vm.createContext({
        fetch, TextEncoder, TextDecoder, atob, btoa, AbortController,
        setTimeout(callback, delay) {
            if (delay < 15000) return queueMicrotask(callback);
            assert.equal(delay, 15000);
            const id = Symbol();
            timers.set(id, callback);
            return id;
        },
        clearTimeout: (id) => timers.delete(id),
        FIREBASE_DB_URL: 'https://cloud.invalid',
        chrome: { storage: { local: storage }, runtime: { getManifest: () => ({ version: 'test' }) } },
        DB: storage,
        document: {
            getElementById: (id) => ({
                'btn-generate-sync': button,
                'sync-provider-select': { value: 'firebase' },
                'onboarding-own-name': { value: 'One' }
            })[id]
        },
        showToast() {},
        renderMobileSyncSettings() {},
        loadCloudProfilesForDesktop() {},
        renderProfileBar() {},
        updateProfileContextBar() {},
        alert: (message) => paired.reject(new Error(message)),
        isSyncClient: () => false,
        logSync(message) {
            logs.push(message);
            if (/V2 upload |Successfully uploaded|Upload mislukt/.test(message)) uploaded.resolve(message);
        }
    });
    const providersEnd = source === app ? '// Merge freshly read profiles' : '// Lees de hele status-collectie';
    const providers = source.slice(source.indexOf('const CryptoSync ='), source.indexOf(providersEnd));
    vm.runInContext(shared + '\n' + providers + extractFunction(source, 'pushUserDataToCloud'), ctx);
    const functions = source === background ? ['extensionVersion'] : [
        'generateMobileSync', 'createOwnDashboardFromOnboarding', 'dbGetPromise', 'dbSetPromise',
        'getOrCreateProfileId', 'cs2ReadStatusAll', 'cs2ReadState'
    ];
    for (const name of functions) vm.runInContext(extractFunction(source, name), ctx);
    if (source === app) {
        const dashboardConfig = app.slice(app.indexOf('function ensureDashboardConfig('), app.indexOf('function _setBlockOverride('));
        vm.runInContext(dashboardConfig, ctx);
    }
    ctx.state = {};
    return {
        encode: (doc) => ctx.encodeCloudDocument(doc, stored.lt_sync_config),
        decode: (raw) => JSON.parse(JSON.stringify(ctx.decodeCloudDocument(raw, stored.lt_sync_config))),
        update: (sub, mutator) => ctx.cs2UpdateEnc(stored.lt_sync_config, sub, mutator),
        async pair(initial, onboarding) {
            ctx.state = initial;
            if (onboarding) await ctx.createOwnDashboardFromOnboarding();
            else ctx.generateMobileSync();
            return paired.promise;
        },
        readState: () => ctx.cs2ReadState(stored.lt_sync_config),
        logs,
        expireNextRequest() {
            assert.ok(timers.size > 0);
            timers.values().next().value();
        },
        pendingTimeouts: () => timers.size,
        saveDashboardConfig(dashboardConfig) {
            ctx.state.dashboardConfig = dashboardConfig;
            ctx.persistDashboardConfig();
        },
        dashboardWritePending: () => vm.runInContext('_dashCfgWriteInFlight || _dashCfgWriteQueued', ctx),
        upload(syncStatus) {
            ctx.state.syncStatus = syncStatus;
            uploaded = Promise.withResolvers();
            ctx.pushUserDataToCloud({ syncStatus });
            return uploaded.promise;
        }
    };
}

function reply(status, value = null, etag = null) {
    return {
        ok: status >= 200 && status < 300, status,
        headers: new Headers(etag ? { ETag: etag } : {}), json: async () => value
    };
}

test('both entry points load the shared sync functions', () => {
    const html = read('index.html');
    const sharedScript = html.indexOf(`<script src="${sharedPath}">`);
    assert.ok(sharedScript >= 0 && sharedScript < html.indexOf('<script src="app.js'));
    assert.ok(background.includes(`importScripts("${sharedPath}")`));
    assert.ok(read('sw.js').includes(`'./${sharedPath}'`));
});

const older = { chatgpt: { lastSynced: 100, pctRemaining5h: 88 }, claude: null, zai: null };
const latest = {
    chatgpt: { lastSynced: 200, pctRemaining5h: 61 },
    zai: { lastSynced: 200, pctRemaining: 42 },
    codex: { lastSynced: 200, pctRemainingMonthly: 45, resetMonthlyAbsoluteTs: Date.parse('2026-10-25T01:30:00Z') }
};
const claude = { lastSynced: 90, pctRemaining: 51 };
const secondProfile = { label: 'Two', syncStatus: { chatgpt: { lastSynced: 300 } } };

for (const [olderSource, newerSource, delayName] of [[app, background, 'app'], [background, app, 'worker']]) {
    test(`Firebase keeps the latest measurement when the ${delayName} arrives late and retries`, async () => {
        const statusPath = '/profiles/test-bin/status/p1.json';
        const legacyPath = '/profiles/test-bin/data.json';
        const guardedPaths = [statusPath, legacyPath];
        const nodes = new Map();
        const waiting = Promise.withResolvers();
        const release = Promise.withResolvers();
        const traced = new Map(guardedPaths.map((node) => [node, []]));
        let blocked = 0;

        function fetchAs(delayed) {
            return async (url, { method = 'GET', headers, body }) => {
                const node = new URL(url).pathname;
                const known = nodes.get(node);
                const etag = known ? `"v${known.version}"` : 'null_etag';
                const trace = delayed ? traced.get(node) : null;
                if (trace) trace.push([method, method === 'GET' ? etag : headers['if-match']]);
                if (method === 'GET') {
                    assert.equal(headers['X-Firebase-ETag'], 'true');
                    return reply(200, known?.raw ?? null, etag);
                }
                assert.equal(method, 'PUT');
                const archive = node.includes('/archive/');
                if (!archive) assert.ok(headers['if-match'], `missing If-Match on ${node}`);
                if (trace?.length === 2) {
                    if (++blocked === guardedPaths.length) waiting.resolve();
                    await release.promise;
                    if (node === statusPath) throw new TypeError('temporary network failure');
                    return reply(412);
                }
                if (!archive && headers['if-match'] !== etag) return reply(412);
                nodes.set(node, { raw: JSON.parse(body), version: (known?.version ?? 0) + 1 });
                return reply(200);
            };
        }

        const delayed = createWriter(olderSource, fetchAs(true));
        const fresh = createWriter(newerSource, fetchAs(false));
        const profile = { label: 'One', syncStatus: { claude } };
        nodes.set(statusPath, { raw: fresh.encode(profile), version: 1 });
        nodes.set(legacyPath, { raw: fresh.encode({ profiles: { p1: profile, p2: secondProfile } }), version: 1 });

        const pending = delayed.upload(older);
        await waiting.promise;
        try {
            assert.match(await fresh.upload(latest), /V2 upload ok/);
        } finally {
            release.resolve();
        }
        assert.match(await pending, /V2 upload ok/);

        const status = fresh.decode(nodes.get(statusPath).raw);
        const legacy = fresh.decode(nodes.get(legacyPath).raw);
        const expected = { ...latest, claude };
        assert.deepEqual(status.syncStatus, expected);
        assert.deepEqual(Object.keys(legacy.profiles), ['p1', 'p2']);
        assert.deepEqual(legacy.profiles.p2, secondProfile);
        assert.deepEqual(legacy.profiles.p1.syncStatus, expected);
        assert.deepEqual(legacy.syncStatus, expected);
        for (const trace of traced.values()) {
            assert.deepEqual(trace, [['GET', '"v1"'], ['PUT', '"v1"'], ['GET', '"v2"'], ['PUT', '"v2"']]);
        }
    });
}

test('Firebase retries a failed read and never overwrites unreadable ciphertext', async () => {
    let reads = 0;
    let writes = 0;
    let mutations = 0;
    const writer = createWriter(app, async (url, { method = 'GET' }) => {
        if (method !== 'GET') {
            writes++;
            return reply(200);
        }
        if (++reads === 1) return reply(503, null, '"error"');
        if (reads === 2) return reply(200, { data: 'invalid' }); // Hidden ETag does not bypass decoding.
        return reply(200, { data: 'invalid' }, '"v1"');
    });
    await assert.rejects(writer.update('status/p1', () => { mutations++; }));
    assert.equal(reads, 5);
    assert.equal(mutations, 0);
    assert.equal(writes, 0);
});

for (const { shape, onboarding, uploadSource } of [
    { shape: 'empty', onboarding: false, uploadSource: app },
    { shape: 'ciphertext', onboarding: false, uploadSource: background },
    { shape: 'object', onboarding: true, uploadSource: app }
]) {
    test(`Firebase uploads after creating a pairing with a legacy node containing ${shape}`, async () => {
        const nodes = new Map();
        const writes = new Map();
        let legacyPath;
        let initialCiphertext;
        const fetch = async (url, { method = 'GET', headers, body }) => {
            const node = new URL(url).pathname;
            if (node.match(/^\/profiles\/fb-[^/]+\.json$/)) {
                assert.equal(method, 'PUT');
                const initial = JSON.parse(body);
                assert.equal(typeof initial.data, 'string');
                initialCiphertext = initial.data;
                legacyPath = node.replace(/\.json$/, '/data.json');
                if (shape !== 'empty') nodes.set(legacyPath, shape === 'ciphertext' ? initial.data : initial);
                return reply(200);
            }
            const etag = nodes.has(node) ? '"initial"' : 'null_etag';
            if (method === 'GET') {
                return reply(200, nodes.get(node) ?? null, headers?.['X-Firebase-ETag'] ? etag : null);
            }
            assert.equal(method, 'PUT');
            if (!node.includes('/archive/')) assert.equal(headers['if-match'], etag);
            writes.set(node, headers['if-match']);
            nodes.set(node, JSON.parse(body));
            return reply(200);
        };
        const creator = createWriter(app, fetch);
        const pairing = await creator.pair({
            userLogs: [{ timestamp: Date.now(), text: 'existing log' }],
            userThreads: [{ id: 'existing-thread' }],
            userSettings: { theme: 'dark' },
            syncStatus: { claude },
            dashboardConfig: { labels: { 'p1|claude': 'Custom label' } }
        }, onboarding);
        assert.equal(pairing.provider, 'firebase');
        const initial = creator.decode(initialCiphertext);
        const beforeUpload = await creator.readState();
        assert.deepEqual(JSON.parse(JSON.stringify(beforeUpload)), shape === 'empty' ? null : initial);

        const writer = uploadSource === app ? creator : createWriter(uploadSource, fetch, pairing);
        assert.match(await writer.upload(latest), /V2 upload ok.*status: ok.*archive: ok.*meta: ok.*data: ok/);
        assert.equal(writes.size, 4);
        assert.equal(writes.get(legacyPath), shape === 'empty' ? 'null_etag' : '"initial"');
        const migrated = writer.decode(nodes.get(legacyPath));
        assert.equal(typeof nodes.get(legacyPath).data, 'string');
        const expected = shape === 'empty' ? latest : { ...latest, claude };
        assert.deepEqual(migrated.syncStatus, expected);
        assert.deepEqual(migrated.profiles.p1.syncStatus, expected);
        if (shape !== 'empty') {
            assert.deepEqual(migrated.logs, initial.logs);
            assert.deepEqual(migrated.threads, initial.threads);
            assert.deepEqual(migrated.settings, initial.settings);
            assert.deepEqual(migrated.dashboardConfig, initial.dashboardConfig);
        }
        assert.equal(creator.pendingTimeouts(), 0);
        assert.equal(writer.pendingTimeouts(), 0);
    });
}

for (const source of [app, background]) {
    test(`Firebase reports individual successes after a partial upload in the ${source === app ? 'app' : 'worker'}`, async () => {
        const writer = createWriter(source, async (url, { method = 'GET' }) => {
            if (new URL(url).pathname.endsWith('/data.json')) return reply(403);
            return method === 'GET' ? reply(200, null, 'null_etag') : reply(200);
        });
        const message = await writer.upload(latest);
        assert.match(message, /V2 upload gedeeltelijk gelukt.*status: ok.*archive: ok.*meta: ok.*data: mislukt \(cs2 read 403\)/);
        assert.doesNotMatch(message, /FOUT/);
    });
}

for (const blockedHeader of ['hidden ETag', 'X-Firebase-ETag', 'If-Match']) {
    test(`Firebase merges and writes without a precondition with ${blockedHeader}`, async () => {
        const reads = [];
        const writes = [];
        let raw;
        const writer = createWriter(app, async (url, { method = 'GET', headers, body }) => {
            if (method === 'GET') {
                const conditional = !!headers?.['X-Firebase-ETag'];
                reads.push(conditional);
                if (conditional && blockedHeader === 'X-Firebase-ETag') throw new TypeError('preflight blocked');
                const etag = conditional && blockedHeader !== 'hidden ETag' ? '"current"' : null;
                return reply(200, raw, etag);
            }
            assert.equal(method, 'PUT');
            writes.push(headers['if-match']);
            if (headers['if-match'] && blockedHeader === 'If-Match') {
                // A peer can write while this browser keeps retrying its blocked request.
                raw = writer.encode({ syncStatus: { ...latest, gemini: { lastSynced: writes.length + 200 } } });
                throw new TypeError('preflight blocked');
            }
            raw = JSON.parse(body);
            return reply(200);
        });
        raw = writer.encode({ syncStatus: latest });
        await writer.update('status/p1', doc => {
            doc.syncStatus = { ...doc.syncStatus, claude };
        });
        assert.equal(writes.at(-1), undefined);
        assert.deepEqual(writer.decode(raw).syncStatus, blockedHeader === 'If-Match'
            ? { ...latest, claude, gemini: { lastSynced: 205 } }
            : { ...latest, claude });
        if (blockedHeader === 'hidden ETag') assert.deepEqual(reads, [true]);
        if (blockedHeader === 'X-Firebase-ETag') assert.deepEqual(reads, [true, false]);
        if (blockedHeader === 'If-Match') {
            assert.deepEqual(writes, ['"current"', '"current"', '"current"', '"current"', '"current"', undefined]);
            assert.deepEqual(reads, [true, true, true, true, true, false]);
        }
    });
}

function waitForAbort(signal) {
    return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
}

test('Firebase retries when the JSON body hangs after the response headers', async () => {
    const readingBody = Promise.withResolvers();
    let reads = 0;
    let written;
    const writer = createWriter(app, async (url, { method = 'GET', headers, signal }) => {
        if (method === 'PUT') {
            written = headers['if-match'];
            return reply(200);
        }
        if (++reads === 1) {
            const response = reply(200, null, '"stale"');
            response.json = () => {
                readingBody.resolve(signal);
                return waitForAbort(signal);
            };
            return response;
        }
        return reply(200, null, 'null_etag');
    });
    const update = writer.update('meta', () => ({ schema: 2 }));
    const signal = await readingBody.promise;
    writer.expireNextRequest();
    await update;
    assert.equal(signal.aborted, true);
    assert.equal(reads, 2);
    assert.equal(written, 'null_etag');
    assert.equal(writer.pendingTimeouts(), 0);
});

test('dashboard writes the queued change after a hung fetch fails and the other node finishes', async () => {
    const firstMeta = Promise.withResolvers();
    const firstData = Promise.withResolvers();
    const releaseData = Promise.withResolvers();
    let metaReads = 0;
    const saved = { meta: [], data: [] };
    const writer = createWriter(app, async (url, { method = 'GET', body, signal }) => {
        const part = new URL(url).pathname.split('/').at(-1).replace('.json', '');
        if (method === 'GET') {
            if (part === 'meta') {
                metaReads++;
                if (metaReads === 1) {
                    firstMeta.resolve(signal);
                    return waitForAbort(signal);
                }
                if (metaReads <= 5) return reply(503);
            }
            return reply(200, null); // ETag hidden.
        }
        const label = writer.decode(JSON.parse(body)).dashboardConfig.labels.card;
        if (part === 'data' && saved.data.length === 0) {
            firstData.resolve();
            await releaseData.promise;
        }
        saved[part].push(label);
        return reply(200);
    });
    const dashboardConfig = { labels: { card: 'First' } };
    writer.saveDashboardConfig(dashboardConfig);
    const [signal] = await Promise.all([firstMeta.promise, firstData.promise]);
    dashboardConfig.labels.card = 'Second';
    writer.saveDashboardConfig(dashboardConfig);
    writer.expireNextRequest();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(signal.aborted, true);
    assert.equal(metaReads, 5);
    assert.equal(writer.dashboardWritePending(), true);
    assert.deepEqual(saved, { meta: [], data: [] });

    releaseData.resolve();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(metaReads, 6);
    assert.deepEqual(saved, { meta: ['Second'], data: ['First', 'Second'] });
    assert.match(writer.logs.at(-1), /Cloud write failed: cs2 read 503/);
    assert.equal(writer.dashboardWritePending(), false);
    assert.equal(writer.pendingTimeouts(), 0);
});

test('npoint rereads and merges after a failed write, including older single-profile data', async () => {
    let raw;
    const methods = [];
    const writer = createWriter(app, async (url, { method = 'GET', body }) => {
        methods.push(method);
        if (method === 'GET') return reply(200, raw);
        assert.equal(method, 'POST');
        if (methods.length === 2) {
            raw = writer.encode({ syncStatus: { ...latest, claude } });
            return reply(503);
        }
        raw = JSON.parse(body);
        return reply(200);
    }, { ...config, provider: 'npoint' });
    raw = writer.encode({ syncStatus: { claude } });
    assert.match(await writer.upload(older), /Successfully uploaded/);
    assert.deepEqual(methods, ['GET', 'POST', 'GET', 'POST']);
    const doc = writer.decode(raw);
    assert.deepEqual(doc.profiles.p1.syncStatus, { ...latest, claude });
});

test('all three scrapers carry the absolute reset across a winter-time change', async () => {
    const originalTz = process.env.TZ;
    const resetAt = Date.parse('2026-10-25T01:30:00Z');
    const now = Date.parse('2026-10-25T00:00:00Z');
    const response = {
        rate_limit: { primary_window: { used_percent: 39, limit_window_seconds: 30 * 86400, reset_at: resetAt / 1000 } }
    };
    const viewer = vm.createContext({ escapeHtmlSafe: (text) => text });
    for (const name of ['formatWeeklyTimeMs', 'parseDateResetTime', 'codexMonthlyTime', 'computeProviderPace']) {
        vm.runInContext(extractFunction(app, name), viewer);
    }
    try {
        for (const source of [read('content.js'), background, app]) {
            process.env.TZ = 'Europe/Amsterdam';
            const scraper = vm.createContext({
                fetch: async (url) => {
                    if (url === '/api/auth/session') return reply(200, { accessToken: 'synthetic' });
                    assert.equal(url, '/backend-api/wham/usage');
                    return reply(200, response);
                }
            });
            vm.runInContext(extractFunction(source, 'chatgptUsageInPageFetch'), scraper);
            const { ok, monthly } = await scraper.chatgptUsageInPageFetch();
            assert.equal(ok, true);
            assert.equal(monthly.resetMonthlyAbsoluteTs, resetAt);
            assert.equal(monthly.resetMonthly, 'Reset 25 Oct 2026 02:30');
            for (const tz of ['Europe/Amsterdam', 'America/New_York']) {
                process.env.TZ = tz;
                const [pace] = viewer.computeProviderPace('chatgpt', {}, now, monthly);
                assert.equal(pace.capPct, 61);
                assert.equal(pace.timePct, ((resetAt - now) / (31 * 86400000)) * 100);
                assert.match(pace.resetLabel, />1u 30m</);
            }
            assert.equal(viewer.codexMonthlyTime(monthly, resetAt).timerText, 'Resetting…');
        }

        process.env.TZ = 'America/New_York';
        const legacy = viewer.codexMonthlyTime({ resetMonthly: 'Reset 25 Oct 2026 02:30' }, now);
        assert.equal(legacy.timerText, '6u 30m');
    } finally {
        if (originalTz === undefined) delete process.env.TZ;
        else process.env.TZ = originalTz;
    }
});
