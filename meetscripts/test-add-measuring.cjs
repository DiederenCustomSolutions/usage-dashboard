// node meetscripts/test-add-measuring.cjs
// Checks the "Add measuring profile" panel logic against the real app.js code (no browser needed).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const start = source.indexOf('const ADD_NAME_RE');
const end = source.indexOf('function renderAddMeasuring');
assert.ok(start > 0 && end > start, 'add-measuring block found in app.js');
const ctx = vm.createContext({
    LOGIN_REQUEST_MAX_MS: 5 * 60000,
    escapeHtmlSafe: s => String(s).replace(/[&<>"']/g, c => '&#' + c.charCodeAt(0) + ';')
});
vm.runInContext(source.slice(start, end), ctx);
const run = c => vm.runInContext(c, ctx);
const NOW = 1_000_000_000_000, MIN = 60000;
const st = (req, res) => run(`addMeasuringState(${NOW}, ${JSON.stringify(req)}, ${JSON.stringify(res)})`);

assert.equal(st({}, {}).kind, 'idle');
assert.equal(st({ a: { name: 'anna', at: NOW - 5000 } }, {}).kind, 'pending');
assert.equal(st({ a: { name: 'anna', at: NOW - 6 * MIN } }, {}).kind, 'idle', 'old request is not pending');
const ready = st({}, { a: { name: 'anna', url: 'https://h.ts.net:8443/x', at: NOW - 1000, until: NOW + 29 * MIN, public: true } });
assert.deepEqual({ ...ready }, { kind: 'ready', url: 'https://h.ts.net:8443/x', name: 'anna', pub: true });
assert.equal(st({}, { a: { name: 'anna', url: 'u', at: NOW - 40 * MIN, until: NOW - 10 * MIN } }).kind, 'idle', 'expired link');
assert.equal(st({}, { a: { name: 'anna', error: 'name already exists', at: NOW - 1000 } }).kind, 'failed');
assert.equal(st({}, { a: { error: 'x', at: NOW - 11 * MIN } }).kind, 'idle', 'old error is gone');
assert.equal(st({}, { old: { url: 'u1', at: NOW - 9 * MIN, until: NOW + MIN }, new: { url: 'u2', at: NOW - MIN, until: NOW + 29 * MIN } }).url, 'u2', 'newest result wins');

const html = o => run(`addMeasuringHTML(${JSON.stringify(o)})`);
assert.match(html({ kind: 'idle' }), /id="add-measuring-name"[^>]*maxlength="24"/);
assert.match(html({ kind: 'idle' }), /data-add-act="submit"/);
assert.match(html({ kind: 'failed', error: 'name already exists' }), /name already exists/);
const r = html(ready);
assert.match(r, /data-add-act="open"/); assert.match(r, /data-add-act="copy"/); assert.match(r, /public link/);
assert.ok(!r.includes('https://h.ts.net'), 'the link is not put in the page markup');
assert.ok(!html({ kind: 'ready', url: 'u', name: '<b>x</b>' }).includes('<b>'), 'name escaped');

const ok = n => run(`ADD_NAME_RE.test(${JSON.stringify(n)})`);
for (const n of ['anna', 'kevin-lxdg', 'a1']) assert.equal(ok(n), true, n);
for (const n of ['A', 'x', '1abc', 'bad name', 'a;b', 'a'.repeat(25), '']) assert.equal(ok(n), false, n);
console.log('add measuring profile: all checks passed');
