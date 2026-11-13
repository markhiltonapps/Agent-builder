'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { boot, tmpDir, fakeUpstream, openaiOk, closeAll } = require('./helpers');

test.after(() => closeAll());

process.env.MUSER_DEMO_DELAY_MS = '5';

test('api needs the token and a loopback Host header', async () => {
  const t = await boot();
  const bare = await fetch(`${t.url}api/state`);
  assert.equal(bare.status, 401);
  // fetch() will not let us forge Host, so use a raw request to emulate DNS rebinding.
  const rebindStatus = await new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: t.port, path: '/api/state', headers: { host: 'evil.example', 'x-muser-token': t.token } }, (res) => { res.resume(); resolve(res.statusCode); });
    r.on('error', reject);
    r.end();
  });
  assert.equal(rebindStatus, 403, 'a rebound hostname is refused even with the token');
  const ok = await t.call('GET', '/api/state');
  assert.equal(ok.status, 200);
  assert.equal(ok.body.agents.length, 1, 'a default agent is seeded');
  assert.equal(ok.body.active.provider, 'demo');
  await t.app.close();
});

test('the page is served with a CSP and the token injected', async () => {
  const t = await boot();
  const res = await fetch(t.url);
  const html = await res.text();
  assert.match(res.headers.get('content-security-policy'), /script-src 'self'/);
  assert.ok(html.includes(t.token), 'token is embedded for the page');
  assert.ok(!html.includes('__MUSER_TOKEN__'));
  await t.app.close();
});

test('agents: create, edit instructions, validate, delete', async () => {
  const t = await boot();
  const created = await t.call('POST', '/api/agents', { name: 'Coach', role: 'Writing coach', emoji: '✍️', instructions: 'Be blunt.' });
  assert.equal(created.status, 200);
  const id = created.body.agent.id;
  const edited = await t.call('PATCH', `/api/agents/${id}`, { instructions: 'Be kind.' });
  assert.equal(edited.body.agent.instructions, 'Be kind.');
  assert.equal(edited.body.agent.name, 'Coach', 'untouched fields survive a partial edit');
  const tooLong = await t.call('PATCH', `/api/agents/${id}`, { instructions: 'x'.repeat(8001) });
  assert.equal(tooLong.status, 400);
  assert.match(tooLong.body.error, /too long to save/);
  assert.equal((await t.call('POST', '/api/agents', { name: '   ' })).status, 400);
  assert.equal((await t.call('DELETE', `/api/agents/${id}`)).status, 204);
  const state = await t.call('GET', '/api/state');
  assert.equal(state.body.agents.length, 1);
  const last = await t.call('DELETE', `/api/agents/${state.body.agents[0].id}`);
  assert.equal(last.status, 400, 'the last agent cannot be deleted');
  await t.app.close();
});

test('send streams deltas, saves the chat and derives a title', async () => {
  const t = await boot();
  const agent = (await t.call('GET', '/api/state')).body.agents[0];
  const chat = (await t.call('POST', '/api/chats', { agentId: agent.id })).body.chat;
  const r = await t.collect(`/api/chats/${chat.id}/send`, { text: 'Plan my week please' });
  assert.equal(r.events[0].t, 'start');
  assert.ok(r.events.filter((e) => e.t === 'delta').length > 5, 'reply arrives in many pieces');
  assert.equal(r.done.status, 'done');
  assert.equal(r.done.content, r.text, 'streamed text equals the saved reply');
  const saved = (await t.call('GET', `/api/chats/${chat.id}`)).body.chat;
  assert.equal(saved.title, 'Plan my week please');
  assert.deepEqual(saved.messages.map((m) => m.role), ['user', 'assistant']);
  const onDisk = JSON.parse(fs.readFileSync(path.join(t.dataDir, 'chats', `${chat.id}.json`), 'utf8'));
  assert.equal(onDisk.messages[1].content, r.text);
  await t.app.close();
});

test('stop keeps the partial reply and frees the chat; retry regenerates it', async () => {
  const slow = Object.assign(process.env, { MUSER_DEMO_DELAY_MS: '40' });
  const t = await boot();
  const agent = (await t.call('GET', '/api/state')).body.agents[0];
  const chat = (await t.call('POST', '/api/chats', { agentId: agent.id })).body.chat;
  const s = await t.stream(`/api/chats/${chat.id}/send`, { text: 'Tell me something long' });
  let seen = 0;
  let done;
  for await (const e of s.events) {
    if (e.t === 'delta' && ++seen === 3) assert.equal((await t.call('POST', `/api/chats/${chat.id}/stop`)).status, 204);
    if (e.t === 'done') done = e.message;
  }
  assert.equal(done.status, 'stopped');
  assert.ok(done.content.length > 0 && done.content.length < 200, 'partial text is kept');
  const busy = await t.call('GET', `/api/chats/${chat.id}`);
  assert.equal(busy.body.busy, false);

  slow.MUSER_DEMO_DELAY_MS = '1';
  const retried = await t.collect(`/api/chats/${chat.id}/retry`);
  assert.equal(retried.done.status, 'done');
  const saved = (await t.call('GET', `/api/chats/${chat.id}`)).body.chat;
  assert.deepEqual(saved.messages.map((m) => m.role), ['user', 'assistant'], 'retry replaces the reply, not appends');
  assert.equal(saved.messages[1].content, retried.text);
  await t.app.close();
});

test('closing the connection counts as Stop and the partial reply is saved', async () => {
  process.env.MUSER_DEMO_DELAY_MS = '40';
  const t = await boot();
  const agent = (await t.call('GET', '/api/state')).body.agents[0];
  const chat = (await t.call('POST', '/api/chats', { agentId: agent.id })).body.chat;
  const s = await t.stream(`/api/chats/${chat.id}/send`, { text: 'hello there' });
  let n = 0;
  try {
    for await (const e of s.events) if (e.t === 'delta' && ++n === 3) s.abort();
  } catch { /* aborted */ }
  await new Promise((r) => setTimeout(r, 200));
  const saved = (await t.call('GET', `/api/chats/${chat.id}`)).body;
  assert.equal(saved.busy, false);
  assert.equal(saved.chat.messages[1].status, 'stopped');
  assert.ok(saved.chat.messages[1].content.length > 0);
  process.env.MUSER_DEMO_DELAY_MS = '5';
  await t.app.close();
});

test('a second send while replying is refused', async () => {
  process.env.MUSER_DEMO_DELAY_MS = '40';
  const t = await boot();
  const agent = (await t.call('GET', '/api/state')).body.agents[0];
  const chat = (await t.call('POST', '/api/chats', { agentId: agent.id })).body.chat;
  const first = await t.stream(`/api/chats/${chat.id}/send`, { text: 'one' });
  const iter = first.events[Symbol.asyncIterator]();
  await iter.next(); // start
  const second = await t.stream(`/api/chats/${chat.id}/send`, { text: 'two' });
  assert.equal(second.status, 409);
  first.abort();
  await iter.next().catch(() => {});
  process.env.MUSER_DEMO_DELAY_MS = '5';
  await t.app.close();
});

test('OpenAI: streams, applies edited instructions to the next reply, surfaces errors, retry recovers', async () => {
  let failNext = false;
  const up = await fakeUpstream(({ res, body, n }) => {
    if (failNext) {
      failNext = false;
      res.writeHead(429, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'quota exceeded for sk-secret-123' } }));
    }
    openaiOk(['Hel', 'lo ', 'there'])({ res, body, n });
  });
  const t = await boot({ env: { OPENAI_BASE_URL: up.base, OPENAI_API_KEY: 'sk-secret-123' } });
  assert.equal((await t.call('GET', '/api/state')).body.active.provider, 'openai');
  const agent = (await t.call('GET', '/api/state')).body.agents[0];
  const chat = (await t.call('POST', '/api/chats', { agentId: agent.id })).body.chat;

  const r1 = await t.collect(`/api/chats/${chat.id}/send`, { text: 'hi' });
  assert.equal(r1.text, 'Hello there');
  assert.match(up.seen[0].body.messages[0].content, /warm, direct and concise/);
  assert.equal(up.seen[0].headers.authorization, 'Bearer sk-secret-123');

  await t.call('PATCH', `/api/agents/${agent.id}`, { instructions: 'Always answer in pirate speak.' });
  await t.collect(`/api/chats/${chat.id}/send`, { text: 'again' });
  assert.match(up.seen[1].body.messages[0].content, /pirate speak/, 'edited instructions apply to the very next reply');
  assert.equal(up.seen[1].body.messages.filter((m) => m.role === 'user').length, 2, 'history is sent');

  failNext = true;
  const bad = await t.collect(`/api/chats/${chat.id}/send`, { text: 'fail please' });
  assert.equal(bad.done.status, 'error');
  assert.match(bad.done.error, /Rate limited/);
  assert.ok(!bad.done.error.includes('sk-secret-123'), 'the key never leaks into an error');
  const fixed = await t.collect(`/api/chats/${chat.id}/retry`);
  assert.equal(fixed.done.status, 'done');
  assert.equal(fixed.text, 'Hello there');
  const history = up.seen.at(-1).body.messages.filter((m) => m.role !== 'system');
  assert.equal(history.at(-1).content, 'fail please', 'retry re-sends the failed user message');
  await t.app.close();
  await up.close();
});

test('Anthropic: parses text deltas and sends alternating roles', async () => {
  const up = await fakeUpstream(({ res }) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const text of ['Bon', 'jour']) res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text } })}\n\n`);
    res.write(`data: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
    res.end();
  });
  const t = await boot({ env: { ANTHROPIC_BASE_URL: up.base, ANTHROPIC_API_KEY: 'k' } });
  const agent = (await t.call('GET', '/api/state')).body.agents[0];
  const chat = (await t.call('POST', '/api/chats', { agentId: agent.id })).body.chat;
  const r = await t.collect(`/api/chats/${chat.id}/send`, { text: 'salut' });
  assert.equal(r.text, 'Bonjour');
  assert.equal(up.seen[0].url, '/v1/messages');
  assert.equal(up.seen[0].headers['x-api-key'], 'k');
  assert.match(up.seen[0].body.system, /warm, direct/);
  assert.equal(up.seen[0].body.messages[0].role, 'user');
  await t.app.close();
  await up.close();
});

test('chats survive a restart; a reply cut off mid-stream is marked interrupted and can be retried', async () => {
  const dataDir = tmpDir();
  process.env.MUSER_DEMO_DELAY_MS = '5';
  let t = await boot({ dataDir });
  const agent = (await t.call('GET', '/api/state')).body.agents[0];
  const chat = (await t.call('POST', '/api/chats', { agentId: agent.id })).body.chat;
  await t.collect(`/api/chats/${chat.id}/send`, { text: 'remember me' });
  await t.call('PATCH', `/api/chats/${chat.id}`, { title: 'Pinned thing', pinned: true });
  await t.app.close();

  // Simulate kill -9 mid-reply: a message left in "streaming" on disk.
  const file = path.join(dataDir, 'chats', `${chat.id}.json`);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  raw.messages.push({ id: 'msg_u', role: 'user', content: 'second question', status: 'done', createdAt: Date.now() });
  raw.messages.push({ id: 'msg_a', role: 'assistant', content: 'partial ans', status: 'streaming', createdAt: Date.now() });
  fs.writeFileSync(file, JSON.stringify(raw));

  t = await boot({ dataDir });
  assert.equal(t.app.store.recovered, 1);
  const state = (await t.call('GET', '/api/state')).body;
  assert.equal(state.chats.length, 1);
  assert.equal(state.chats[0].title, 'Pinned thing');
  assert.equal(state.chats[0].pinned, true);
  const loaded = (await t.call('GET', `/api/chats/${chat.id}`)).body.chat;
  assert.equal(loaded.messages[0].content, 'remember me');
  assert.equal(loaded.messages[3].status, 'interrupted');
  assert.equal(loaded.messages[3].content, 'partial ans');
  const retried = await t.collect(`/api/chats/${chat.id}/retry`);
  assert.equal(retried.done.status, 'done');
  await t.app.close();
});

test('a corrupt chat file is parked, not deleted, and does not block startup', async () => {
  const dataDir = tmpDir();
  let t = await boot({ dataDir });
  await t.app.close();
  fs.writeFileSync(path.join(dataDir, 'chats', 'chat_bad.json'), '{not json');
  t = await boot({ dataDir });
  assert.equal((await t.call('GET', '/api/state')).status, 200);
  assert.ok(fs.readdirSync(path.join(dataDir, 'chats')).some((f) => f.includes('corrupt')));
  await t.app.close();
});

test('settings: keys are write-only and never returned', async () => {
  const t = await boot();
  const put = await t.call('PUT', '/api/settings', { keys: { openai: 'sk-live-xyz' }, provider: 'openai', openaiModel: 'gpt-4o-mini' });
  assert.equal(put.status, 200);
  assert.equal(put.body.settings.savedKey.openai, true);
  assert.ok(!JSON.stringify(put.body).includes('sk-live-xyz'));
  assert.ok(!JSON.stringify((await t.call('GET', '/api/state')).body).includes('sk-live-xyz'));
  assert.equal(fs.statSync(path.join(t.dataDir, 'settings.json')).mode & 0o077, 0, 'settings file is private');
  await t.app.close();
});

test('missing key gives a clear, retryable error instead of a hang', async () => {
  const t = await boot();
  await t.call('PUT', '/api/settings', { provider: 'openai' });
  const agent = (await t.call('GET', '/api/state')).body.agents[0];
  const chat = (await t.call('POST', '/api/chats', { agentId: agent.id })).body.chat;
  const r = await t.collect(`/api/chats/${chat.id}/send`, { text: 'hi' });
  assert.equal(r.done.status, 'error');
  assert.match(r.done.error, /API key/);
  await t.app.close();
});
