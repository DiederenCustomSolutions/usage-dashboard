const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const repo = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(repo, 'app.js'), 'utf8');
assert.doesNotMatch(source, /qrserver\.com/i);

const html = fs.readFileSync(path.join(repo, 'index.html'), 'utf8');
const scripts = [...html.matchAll(/<script src="([^"]+)"/g)].map(([, src]) => src.replaceAll('&amp;', '&'));
const appScript = scripts.find(src => src.startsWith('app.js?'));
const qrScript = 'lib/qrcode.min.js';
assert.ok(appScript && scripts.indexOf(qrScript) >= 0 && scripts.indexOf(qrScript) < scripts.indexOf(appScript));
const worker = fs.readFileSync(path.join(repo, 'sw.js'), 'utf8');
assert.ok(worker.includes(`'./${qrScript}'`) && worker.includes(`'./${appScript}'`));

const elements = new Map();
const config = {
    lt_sync_config: { enabled: true, pairingKey: 'LT-TEST', binId: 'fixture', provider: 'firebase' },
    lt_pwa_host: 'https://example.invalid/dashboard/',
    lt_profile_label: 'Test & profiel'
};
const context = vm.createContext({
    URL,
    URLSearchParams,
    DB: { get: (_keys, callback) => callback(config) },
    document: {
        getElementById(id) {
            if (!elements.has(id)) elements.set(id, { style: {} });
            return elements.get(id);
        }
    },
    isSyncClient: () => false,
    state: {}
});
vm.runInContext(fs.readFileSync(path.join(repo, 'lib/qrcode.min.js'), 'utf8'), context);

function loadFunctions(start, end) {
    const from = source.indexOf(`function ${start}(`);
    const to = source.indexOf(`function ${end}(`, from);
    assert.ok(from >= 0 && to > from, `Find ${start} in app.js`);
    vm.runInContext(source.slice(from, to), context);
}
loadFunctions('pairingQrSvg', 'getAddProfileInviteLink');
loadFunctions('renderMobileSyncSettings', 'generateMobileSync');

function assertLocalSvg(svg) {
    assert.match(svg, /^<svg\b[^>]*width="120" height="120"[^>]*border-radius:4px;/);
    assert.match(svg, /<path d="M[\d,]+/);
    assert.doesNotMatch(svg, /\b(?:href|src)\s*=|<image\b/i);
}

const mobileLink = 'https://example.invalid/dashboard/index.html?key=LT-TEST&bin=fixture&provider=firebase';
const inviteLink = 'https://example.invalid/dashboard/index.html?key=LT-TEST&bin=fixture&join=1&from=Test+%26+profiel&provider=firebase';
const mobileSvg = context.pairingQrSvg(mobileLink);
const inviteSvg = context.pairingQrSvg(inviteLink);
assertLocalSvg(mobileSvg);
assertLocalSvg(inviteSvg);
assert.notEqual(mobileSvg, inviteSvg);

context.openAddProfilePanel();
assert.equal(elements.get('add-profile-url').textContent, inviteLink);
assert.equal(elements.get('add-profile-qr').innerHTML, inviteSvg);

context.renderMobileSyncSettings();
assert.equal(elements.get('sync-pwa-link').href, mobileLink);
assert.equal(elements.get('sync-qrcode').innerHTML, mobileSvg);

config.lt_sync_config = null;
context.openAddProfilePanel();
assert.equal(elements.get('add-profile-qr').innerHTML, '');

console.log('Pairing QR: both screens render local SVGs for their own pairing links.');
