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
    const start = source.indexOf(`function ${name}(`);
    const end = source.indexOf('\n}', start);
    assert.ok(start >= 0 && end > start, name);
    return source.slice(start, end + 2);
}

function createWriter(source, fetch, syncConfig = config) {
    const stored = { lt_sync_config: syncConfig, lt_profile_id: 'p1', lt_profile_label: 'One' };
    const storage = { get: (keys, callback) => callback(stored) };
    const finished = Promise.withResolvers();
    const ctx = vm.createContext({
        fetch, TextEncoder, TextDecoder, atob, btoa,
        setTimeout: queueMicrotask,
        FIREBASE_DB_URL: 'https://cloud.invalid',
        chrome: { storage: { local: storage }, runtime: { getManifest: () => ({ version: 'test' }) } },
        DB: storage,
        isSyncClient: () => false,
        logSync(message) {
            if (message.includes('FOUT')) finished.reject(new Error(message));
            if (message.includes('upload ok') || message.includes('Successfully uploaded')) finished.resolve();
        }
    });
    const providersEnd = source === app ? '// Merge freshly read profiles' : '// Lees de hele status-collectie';
    const providers = source.slice(source.indexOf('const CryptoSync ='), source.indexOf(providersEnd));
    vm.runInContext(shared + '\n' + providers + extractFunction(source, 'pushUserDataToCloud'), ctx);
    if (source === background) vm.runInContext(extractFunction(source, 'extensionVersion'), ctx);
    return {
        encode: (doc) => ctx.encodeCloudDocument(doc, syncConfig),
        decode: (raw) => ctx.decodeCloudDocument(raw, syncConfig),
        update: (sub, mutator) => ctx.cs2UpdateEnc(syncConfig, sub, mutator),
        upload(syncStatus) {
            ctx.state = { syncStatus };
            ctx.pushUserDataToCloud({ syncStatus });
            return finished.promise;
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
            await fresh.upload(latest);
        } finally {
            release.resolve();
        }
        await pending;

        const status = fresh.decode(nodes.get(statusPath).raw);
        const legacy = fresh.decode(nodes.get(legacyPath).raw);
        const expected = { ...latest, claude };
        assert.deepEqual(JSON.parse(JSON.stringify(status.syncStatus)), expected);
        assert.deepEqual(Object.keys(legacy.profiles), ['p1', 'p2']);
        assert.deepEqual(JSON.parse(JSON.stringify(legacy.profiles.p2)), secondProfile);
        assert.deepEqual(JSON.parse(JSON.stringify(legacy.profiles.p1.syncStatus)), expected);
        assert.deepEqual(JSON.parse(JSON.stringify(legacy.syncStatus)), expected);
        for (const trace of traced.values()) {
            assert.deepEqual(trace, [['GET', '"v1"'], ['PUT', '"v1"'], ['GET', '"v2"'], ['PUT', '"v2"']]);
        }
    });
}

test('Firebase retries a failed read and never writes after an unreadable version', async () => {
    let reads = 0;
    let writes = 0;
    let mutations = 0;
    const writer = createWriter(app, async (url, { method = 'GET' }) => {
        if (method !== 'GET') {
            writes++;
            return reply(200);
        }
        if (++reads === 1) return reply(503, null, '"error"');
        if (reads === 2) return reply(200, null); // CORS may hide the ETag.
        return reply(200, { data: 'invalid' }, '"v1"');
    });
    await assert.rejects(writer.update('status/p1', () => { mutations++; }));
    assert.equal(reads, 5);
    assert.equal(mutations, 0);
    assert.equal(writes, 0);
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
    await writer.upload(older);
    assert.deepEqual(methods, ['GET', 'POST', 'GET', 'POST']);
    const doc = JSON.parse(JSON.stringify(writer.decode(raw)));
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
