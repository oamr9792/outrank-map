import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';
const auth = await import('../src/auth.js');

const req = (cookie = '', ip = '10.0.0.1') => ({ headers: { cookie }, socket: { remoteAddress: ip } });
const cookieFrom = (setCookie) => setCookie.split(';')[0];

test('refuses to start a public deployment without a password', () => {
  delete process.env.APP_PASSWORD;
  assert.equal(auth.initAuth({ host: '127.0.0.1' }), false);
  assert.throws(() => auth.initAuth({ host: '0.0.0.0' }), /APP_PASSWORD must be set/);
  process.env.APP_PASSWORD = 'short';
  assert.throws(() => auth.initAuth({ host: '0.0.0.0' }), /at least 12/);
});

test('password login issues a session that authenticates', () => {
  process.env.APP_PASSWORD = 'correct horse battery staple';
  assert.equal(auth.initAuth({ host: '0.0.0.0' }), true);
  assert.equal(auth.isAuthenticated(req()), false);
  assert.throws(() => auth.login(req(), 'wrong password!!'), (e) => e.status === 401);
  const cookie = cookieFrom(auth.login(req(), 'correct horse battery staple'));
  assert.equal(auth.isAuthenticated(req(cookie)), true);
  assert.equal(auth.isAuthenticated(req(cookie.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A')))), false);
  auth.logout(req(cookie));
  assert.equal(auth.isAuthenticated(req(cookie)), false);
});

test('locks an address out after repeated failures', () => {
  for (let i = 0; i < 8; i++) assert.throws(() => auth.login(req('', '10.9.9.9'), 'nope nope nope'), (e) => e.status === 401);
  assert.throws(() => auth.login(req('', '10.9.9.9'), 'correct horse battery staple'), (e) => e.status === 429);
  // Another address is unaffected.
  assert.ok(auth.login(req('', '10.0.0.2'), 'correct horse battery staple'));
});
