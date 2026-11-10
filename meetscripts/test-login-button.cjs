// node meetscripts/test-login-button.cjs
// Checks the Log in button logic against the real app.js code (no browser needed).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const start = source.indexOf('const LOGIN_REQUEST_MAX_MS');
const end = source.indexOf('function requestLoginLink');
assert.ok(start > 0 && end > start, 'login block found in app.js');
let syncClient = { binId: 'b' };
const ctx = vm.createContext({
    state: { loginRequests: {}, loginLinks: {} }, Date, isSyncClient: () => syncClient,
    escapeHtmlSafe: s => String(s).replace(/[&<>"']/g, c => '&#' + c.charCodeAt(0) + ';')
});
vm.runInContext(source.slice(start, end), ctx);
const run = c => vm.runInContext(c, ctx);
const NOW = 1_000_000_000_000, MIN = 60000;
const err = { provider: 'claude', message: 'No data received — check if logged in to Claude.ai on this Chrome profile' };

// Only the "not logged in" error gets a button; other errors do not.
assert.equal(run(`loginErrorNeedsLogin(${JSON.stringify(err)})`), true);
assert.equal(run(`loginErrorNeedsLogin({message:"Rate limited"})`), false);
assert.equal(run(`loginErrorNeedsLogin(undefined)`), false);

const st = (req, link, now = NOW) => run(`loginButtonState("p", ${now}, ${JSON.stringify(req)}, ${JSON.stringify(link)})`);
assert.deepEqual({ ...st({}, {}) }, { kind: 'idle' });
assert.deepEqual({ ...st({ p: { at: NOW - 5000 } }, {}) }, { kind: 'pending' });
assert.deepEqual({ ...st({ p: { at: NOW - 6 * MIN } }, {}) }, { kind: 'idle' }, 'old request is not pending');
assert.deepEqual({ ...st({}, { p: { url: 'http://h:1/x', at: NOW - 1000, until: NOW + 29 * MIN } }) }, { kind: 'ready', url: 'http://h:1/x' });
assert.equal(st({}, { p: { url: 'http://h:1/x', at: NOW - 40 * MIN, until: NOW - 10 * MIN } }).kind, 'idle', 'expired link');
assert.equal(st({ p: { at: NOW - 1000 } }, { p: { url: 'u', at: NOW - 40 * MIN, until: NOW - 10 * MIN } }).kind, 'pending', 'new request after an expired link');
assert.equal(st({}, { p: { error: 'could not start the login link', at: NOW - 1000 } }).kind, 'failed');
assert.equal(st({ p: { at: NOW } }, { p: { error: 'x', at: NOW - 5000 } }).kind, 'pending', 'retry after a failure');

// HTML: button only in that state, only on a sync client, and the profile id is escaped.
ctx.state = { loginRequests: {}, loginLinks: {} };
const html = prof => run(`loginButtonsHTML(${JSON.stringify(prof)})`);
assert.match(html({ id: 'p1', lastError: err }), /data-login-act="request"[^>]*>.*Log in/s);
assert.equal(html({ id: 'p1', lastError: { message: 'Rate limited' } }), '');
assert.equal(html({ id: 'p1' }), '');
syncClient = null;
assert.equal(html({ id: 'p1', lastError: err }), '');
syncClient = { binId: 'b' };
assert.ok(!html({ id: 'a"b', lastError: err }).includes('a"b'), 'id escaped');
vm.runInContext(`state.loginLinks = { p1: { url: 'http://h:1/x', at: ${Date.now()}, until: ${Date.now() + 600000} } }`, ctx);
const ready = html({ id: 'p1', lastError: err });
assert.match(ready, /data-login-act="open"/);
assert.match(ready, /data-login-act="copy"/);
assert.ok(!ready.includes('http://h:1/x'), 'the link is not put in the page markup');
console.log('login button: all checks passed');
