'use strict';
// LAN mode must be reachable from other devices, and unusable without the secret key.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const os = require('node:os');
const { createApp } = require('../src/core/server');
const { tmpDir } = require('./helpers');

const KEY = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const lanIp = Object.values(os.networkInterfaces()).flat().find((a) => a && a.family === 'IPv4' && !a.internal)?.address;
const opened = [];
test.after(() => Promise.all(opened.map((a) => a.close().catch(() => {}))));

async function start(opts = {}) {
  const app = createApp({ dataDir: tmpDir(), env: {}, ...opts });
  opened.push(app);
  const { port, token } = await app.listen(0);
  return { app, port, token };
}
// A raw request, so we control the connection address, the Host header and cookies.
function req({ ip, port, path = '/', host, headers = {}, method = 'GET' }) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: ip, port, path, method, headers: { host: host ?? `${ip}:${port}`, ...headers } }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    r.on('error', reject);
    r.end();
  });
}
const cookie = `muser_key=${KEY}`;

test('LAN mode is reachable on the network address, not just loopback', { skip: !lanIp }, async () => {
  const { port } = await start({ lanKey: KEY });
  const r = await req({ ip: lanIp, port, path: `/?key=${KEY}` });
  assert.equal(r.status, 302);
  assert.equal(r.headers.location, '/', 'the key is stripped from the address bar');
  const set = r.headers['set-cookie'][0];
  assert.match(set, /muser_key=a1b2/);
  assert.match(set, /HttpOnly/);
  assert.match(set, /SameSite=Strict/);
});

test('without the key nothing is served: page, assets and API are all locked', { skip: !lanIp }, async () => {
  const { port, token } = await start({ lanKey: KEY });
  for (const p of ['/', '/app.js', '/app.css', '/api/state']) {
    const r = await req({ ip: lanIp, port, path: p, headers: { 'x-muser-token': token } });
    assert.equal(r.status, 401, p);
    assert.ok(!r.body.includes(token), `${p} must not leak the token`);
  }
  const wrong = await req({ ip: lanIp, port, path: '/?key=nope' });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.headers['set-cookie'], undefined, 'a wrong key sets no cookie');
});

test('with the key: the page loads, and the API needs the cookie AND the per-launch token', { skip: !lanIp }, async () => {
  const { port, token } = await start({ lanKey: KEY });
  const page = await req({ ip: lanIp, port, path: '/', headers: { cookie } });
  assert.equal(page.status, 200);
  assert.ok(page.body.includes(token));
  assert.equal((await req({ ip: lanIp, port, path: '/api/state', headers: { cookie, 'x-muser-token': token } })).status, 200);
  assert.equal((await req({ ip: lanIp, port, path: '/api/state', headers: { cookie, 'x-muser-token': 'wrong' } })).status, 401, 'cookie alone is not enough');
  assert.equal((await req({ ip: lanIp, port, path: '/api/state', headers: { 'x-muser-token': token } })).status, 401, 'token alone is not enough');
  assert.equal((await req({ ip: lanIp, port, path: '/api/state', headers: { cookie: 'muser_key=wrong', 'x-muser-token': token } })).status, 401);
});

test('a rebinding hostname is refused even with the key; IPs and .local names work', { skip: !lanIp }, async () => {
  const { port, token } = await start({ lanKey: KEY });
  const h = { cookie, 'x-muser-token': token };
  assert.equal((await req({ ip: lanIp, port, path: '/api/state', headers: h, host: `evil.example:${port}` })).status, 403);
  assert.equal((await req({ ip: lanIp, port, path: '/api/state', headers: h, host: `${lanIp}:${port + 1}` })).status, 403, 'wrong port');
  assert.equal((await req({ ip: lanIp, port, path: '/api/state', headers: h, host: `evil.example` })).status, 403);
  assert.equal((await req({ ip: lanIp, port, path: '/api/state', headers: h, host: `my-laptop.local:${port}` })).status, 200);
});

test('guessing the key is throttled', { skip: !lanIp }, async () => {
  const { port } = await start({ lanKey: KEY });
  for (let i = 0; i < 10; i++) assert.equal((await req({ ip: lanIp, port, path: `/?key=guess${i}` })).status, 401);
  assert.equal((await req({ ip: lanIp, port, path: `/?key=${KEY}` })).status, 429, 'even the right key waits out the lockout');
});

test('the default mode is NOT reachable from the network', { skip: !lanIp }, async () => {
  const { port } = await start({}); // no lanKey
  await assert.rejects(() => req({ ip: lanIp, port, path: '/' }), (e) => e.code === 'ECONNREFUSED');
  const local = await req({ ip: '127.0.0.1', port, path: '/' });
  assert.equal(local.status, 200, 'loopback still works, no key needed');
});

test('the app icon is public so the browser tab icon loads before sign-in', { skip: !lanIp }, async () => {
  const { port } = await start({ lanKey: KEY });
  assert.equal((await req({ ip: lanIp, port, path: '/icon.png' })).status, 200);
});
