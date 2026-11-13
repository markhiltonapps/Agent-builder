'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { boot, tmpDir, fakeUpstream, scriptedOpenAI, turn, closeAll } = require('./helpers');

test.after(() => closeAll());
process.env.MUSER_DEMO_DELAY_MS = '1';

// A booted app wired to a scripted model, with a shared "Downloads" folder.
async function setup(steps, { share = true, dataDir } = {}) {
  const up = await fakeUpstream(scriptedOpenAI(steps));
  const t = await boot({ dataDir, env: { OPENAI_BASE_URL: up.base, OPENAI_API_KEY: 'sk-test' } });
  const dl = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'muser-dl-')));
  fs.writeFileSync(path.join(dl, 'old.pdf'), 'old');
  fs.writeFileSync(path.join(dl, 'new.pdf'), 'new');
  if (share) assert.equal((await t.call('PUT', '/api/settings', { folders: [dl] })).status, 200);
  const agent = (await t.call('GET', '/api/state')).body.agents[0];
  const chat = (await t.call('POST', '/api/chats', { agentId: agent.id })).body.chat;
  const finish = async () => { await t.app.close(); await up.close(); };
  return { t, up, dl, agent, chat, finish, ask: (opts) => turn(t, chat.id, opts), saved: async () => (await t.call('GET', `/api/chats/${chat.id}`)).body.chat };
}

test('read-only tools run at once, no card; the model sees the real result', async () => {
  const s = await setup([({ tools }) => ({ tools: [{ name: 'list_files', args: { path: s_dl() } }] }), { text: 'I found two PDFs.' }]);
  function s_dl() { return s.dl; }
  const r = await s.ask({ text: 'what is in my downloads?', decide: () => assert.fail('no approval expected') });
  assert.deepEqual(r.tools, ['list_files:pending', 'list_files:running', 'list_files:done'].filter((x) => !x.endsWith('pending')));
  assert.equal(r.done.status, 'done');
  const chat = await s.saved();
  assert.deepEqual(chat.messages.map((m) => m.role), ['user', 'assistant', 'assistant']);
  assert.equal(chat.messages[1].toolCalls[0].status, 'done');
  assert.match(chat.messages[1].toolCalls[0].outcome, /Looked through .* \(2 items\)/);
  assert.equal(chat.messages[2].content, 'I found two PDFs.');
  const second = s.up.seen[1].body.messages;
  const toolMsg = second.find((m) => m.role === 'tool');
  assert.match(toolMsg.content, /old\.pdf/);
  assert.equal(second.find((m) => m.tool_calls).tool_calls[0].function.name, 'list_files');
  assert.equal(s.up.seen[0].body.tools.length, 6, 'all six tools are offered');
  assert.match(s.up.seen[0].body.messages[0].content, new RegExp(s.dl.replace(/[/\\]/g, '.')), 'system prompt names the shared folder');
  await s.finish();
});

test('a destructive tool waits for Allow, changes nothing until then, and is audited', async () => {
  const s = await setup([() => ({ tools: [{ name: 'trash_files', args: { paths: [path.join(s_dl(), 'old.pdf')] } }] }), { text: 'Trashed it.' }]);
  function s_dl() { return s.dl; }
  let seenCard;
  const r = await s.ask({ text: 'trash old.pdf', decide: (call) => {
    seenCard = call;
    assert.ok(fs.existsSync(path.join(s.dl, 'old.pdf')), 'file is untouched while the card is open');
    return 'allow';
  } });
  assert.equal(seenCard.title, 'Allow Muser to move 1 item to Trash?');
  assert.deepEqual(seenCard.items, [`${path.basename(s.dl)}/old.pdf`]);
  assert.match(seenCard.summary, /Move 1 item in .* to Trash/);
  assert.deepEqual(r.tools, ['trash_files:awaiting', 'trash_files:running', 'trash_files:done']);
  assert.ok(!fs.existsSync(path.join(s.dl, 'old.pdf')) && fs.existsSync(path.join(s.dl, 'new.pdf')), 'only the approved file moved');
  const trashDir = path.join(s.t.dataDir, 'trash');
  const manifest = fs.readFileSync(path.join(trashDir, fs.readdirSync(trashDir)[0], 'manifest.jsonl'), 'utf8');
  assert.ok(manifest.includes(path.join(s.dl, 'old.pdf')), 'trash is recoverable: manifest records the original path');
  const log = fs.readFileSync(path.join(s.t.dataDir, 'actions.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(log.length, 1);
  assert.equal(log[0].tool, 'trash_files');
  assert.equal(log[0].decision, 'allow');
  assert.match(JSON.parse(s.up.seen[1].body.messages.find((m) => m.role === 'tool').content).trashed[0], /old\.pdf/);
  await s.finish();
});

test('Deny leaves files alone and tells the model not to retry', async () => {
  const s = await setup([() => ({ tools: [{ name: 'trash_files', args: { paths: [path.join(s_dl(), 'old.pdf')] } }] }), { text: 'Okay, I left it.' }]);
  function s_dl() { return s.dl; }
  const r = await s.ask({ text: 'trash old.pdf', decide: () => 'deny' });
  assert.deepEqual(r.tools, ['trash_files:awaiting', 'trash_files:denied']);
  assert.ok(fs.existsSync(path.join(s.dl, 'old.pdf')));
  assert.match(s.up.seen[1].body.messages.find((m) => m.role === 'tool').content, /denied/);
  assert.equal((await s.saved()).messages[1].toolCalls[0].status, 'denied');
  assert.ok(!fs.existsSync(path.join(s.t.dataDir, 'actions.log')) || !/"outcome"/.test(fs.readFileSync(path.join(s.t.dataDir, 'actions.log'), 'utf8')), 'a denied action is logged as denied, never as done');
  await s.finish();
});

test('Always allow remembers the action for that agent and can be revoked', async () => {
  const s = await setup([
    ({ }) => ({ tools: [{ name: 'make_folder', args: { path: path.join(s_dl(), 'A') } }] }), { text: 'one' },
    () => ({ tools: [{ name: 'make_folder', args: { path: path.join(s_dl(), 'B') } }] }), { text: 'two' },
    () => ({ tools: [{ name: 'make_folder', args: { path: path.join(s_dl(), 'C') } }] }), { text: 'three' },
  ]);
  function s_dl() { return s.dl; }
  await s.ask({ text: 'make A', decide: () => 'always' });
  assert.deepEqual((await s.t.call('GET', '/api/state')).body.agents[0].alwaysAllow, ['make_folder']);
  const second = await s.ask({ text: 'make B', decide: () => assert.fail('already always-allowed: no card') });
  assert.deepEqual(second.tools, ['make_folder:running', 'make_folder:done']);
  assert.ok(fs.existsSync(path.join(s.dl, 'B')));
  const revoke = await s.t.call('PATCH', `/api/agents/${s.agent.id}`, { alwaysAllow: [] });
  assert.deepEqual(revoke.body.agent.alwaysAllow, []);
  const third = await s.ask({ text: 'make C', decide: () => 'deny' });
  assert.equal(third.tools[0], 'make_folder:awaiting', 'asks again after revoking');
  assert.ok(!fs.existsSync(path.join(s.dl, 'C')));
  assert.equal((await s.t.call('PATCH', `/api/agents/${s.agent.id}`, { alwaysAllow: ['rm_rf'] })).status, 400);
  await s.finish();
});

test('requests outside the shared folders are refused without asking the user', async () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-out-'));
  fs.writeFileSync(path.join(outside, 'keep.txt'), 'keep');
  const s = await setup([() => ({ tools: [{ name: 'move_files', args: { moves: [{ from: path.join(outside, 'keep.txt'), to: path.join(s_dl(), 'stolen.txt') }] } }] }), { text: 'That was not allowed.' }]);
  function s_dl() { return s.dl; }
  const r = await s.ask({ text: 'grab that file', decide: () => assert.fail('no card for an invalid request') });
  assert.deepEqual(r.tools, ['move_files:error']);
  assert.ok(fs.existsSync(path.join(outside, 'keep.txt')) && !fs.existsSync(path.join(s.dl, 'stolen.txt')));
  assert.match(JSON.parse(s.up.seen[1].body.messages.find((m) => m.role === 'tool').content).error, /outside the folders/);
  await s.finish();
});

test('Stop while a card is open cancels it; the chat stays valid; Retry asks again', async () => {
  const s = await setup([
    () => ({ tools: [{ name: 'trash_files', args: { paths: [path.join(s_dl(), 'old.pdf')] } }] }),
    { text: 'I will try again.' },
    () => ({ tools: [{ name: 'trash_files', args: { paths: [path.join(s_dl(), 'old.pdf')] } }] }),
    { text: 'Done.' },
  ]);
  function s_dl() { return s.dl; }
  const r = await s.ask({ text: 'trash old.pdf', decide: () => 'stop' });
  assert.equal(r.done.status, 'stopped');
  assert.deepEqual(r.tools, ['trash_files:awaiting', 'trash_files:cancelled']);
  assert.ok(fs.existsSync(path.join(s.dl, 'old.pdf')), 'nothing happened');
  assert.equal((await s.t.call('GET', `/api/chats/${s.chat.id}`)).body.busy, false);
  // The next request must still be a valid conversation: the cancelled call has a tool result.
  const follow = await s.ask({ text: 'never mind, what next?' });
  assert.equal(follow.done.status, 'done');
  const msgs = s.up.seen[1].body.messages;
  const callIdx = msgs.findIndex((m) => m.tool_calls);
  assert.equal(msgs[callIdx + 1].role, 'tool');
  assert.match(msgs[callIdx + 1].content, /cancelled before it ran/);
  // Retry after a stop re-asks instead of silently repeating.
  const again = await s.ask({ retry: true, decide: () => 'allow' });
  assert.equal(again.done.status, 'done');
  assert.ok(!fs.existsSync(path.join(s.dl, 'old.pdf')));
  await s.finish();
});

test('approving the wrong card, or when nothing waits, is refused', async () => {
  const s = await setup([{ text: 'hi' }]);
  assert.equal((await s.t.call('POST', `/api/chats/${s.chat.id}/approve`, { callId: 'x', decision: 'allow' })).status, 409);
  await s.finish();
  const s2 = await setup([() => ({ tools: [{ name: 'make_folder', args: { path: path.join(d2(), 'Z') } }] }), { text: 'ok' }]);
  function d2() { return s2.dl; }
  let wrong;
  await s2.ask({ text: 'go', decide: async (call) => {
    wrong = await s2.t.call('POST', `/api/chats/${s2.chat.id}/approve`, { callId: 'not-this-one', decision: 'allow' });
    const badDecision = await s2.t.call('POST', `/api/chats/${s2.chat.id}/approve`, { callId: call.id, decision: 'whatever' });
    assert.equal(badDecision.status, 400);
    return 'deny';
  } });
  assert.equal(wrong.status, 409);
  assert.ok(!fs.existsSync(path.join(s2.dl, 'Z')));
  await s2.finish();
});

test('malformed tool arguments and unknown tools become errors, not crashes', async () => {
  const s = await setup([{ tools: [{ name: 'make_folder', rawArgs: '{"path": ' }, { name: 'format_disk', args: {} }] }, { text: 'Sorry about that.' }]);
  const r = await s.ask({ text: 'break things' });
  assert.equal(r.done.status, 'done');
  assert.deepEqual(r.tools, ['make_folder:error', 'format_disk:error']);
  const tools = s.up.seen[1].body.messages.filter((m) => m.role === 'tool');
  assert.equal(tools.length, 2, 'every tool call gets a result, or the API rejects the next request');
  await s.finish();
});

test('a model that never stops calling tools is cut off after 8 steps', async () => {
  const s = await setup([() => ({ tools: [{ name: 'list_files', args: { path: s_dl() } }] })]);
  function s_dl() { return s.dl; }
  const r = await s.ask({ text: 'loop' });
  assert.equal(r.done.status, 'error');
  assert.match(r.done.error, /Stopped after 8 steps/);
  assert.equal(s.up.seen.length, 8);
  await s.finish();
});

test('tools are only offered once a folder is shared', async () => {
  const s = await setup([{ text: 'hello' }], { share: false });
  await s.ask({ text: 'hi' });
  assert.equal(s.up.seen[0].body.tools, undefined);
  assert.match(s.up.seen[0].body.messages[0].content, /cannot access the user's files/);
  await s.finish();
});

test('Retry after a finished tool turn replaces only the final text and keeps the tool history', async () => {
  const s = await setup([() => ({ tools: [{ name: 'list_files', args: { path: s_dl() } }] }), { text: 'First answer.' }, { text: 'Second answer.' }]);
  function s_dl() { return s.dl; }
  await s.ask({ text: 'look' });
  const r = await s.ask({ retry: true });
  assert.equal(r.done.content, 'Second answer.');
  const chat = await s.saved();
  assert.deepEqual(chat.messages.map((m) => m.role), ['user', 'assistant', 'assistant']);
  assert.equal(chat.messages[1].toolCalls.length, 1, 'tool step kept');
  assert.equal(chat.messages[2].content, 'Second answer.');
  await s.finish();
});

test('a crash while a card was open: restart cancels it, nothing ran, the chat still works', async () => {
  const dataDir = tmpDir();
  const s = await setup([{ text: 'Fine.' }], { dataDir });
  const file = path.join(dataDir, 'chats', `${s.chat.id}.json`);
  await s.t.app.close();
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  raw.messages.push({ id: 'm1', role: 'user', content: 'trash it', status: 'done', createdAt: Date.now() });
  raw.messages.push({ id: 'm2', role: 'assistant', content: '', status: 'streaming', createdAt: Date.now(), toolCalls: [
    { id: 'call_a', name: 'trash_files', args: { paths: [path.join(s.dl, 'old.pdf')] }, status: 'awaiting', title: 'Allow Muser to move 1 item to Trash?' },
    { id: 'call_b', name: 'move_files', args: {}, status: 'running' },
  ] });
  fs.writeFileSync(file, JSON.stringify(raw));
  const t2 = await boot({ dataDir, env: { OPENAI_BASE_URL: s.up.base, OPENAI_API_KEY: 'sk-test' } });
  const chat = (await t2.call('GET', `/api/chats/${s.chat.id}`)).body.chat;
  assert.equal(chat.messages[1].status, 'interrupted');
  assert.equal(chat.messages[1].toolCalls[0].status, 'cancelled');
  assert.equal(chat.messages[1].toolCalls[1].status, 'interrupted');
  assert.match(chat.messages[1].toolCalls[1].outcome, /may or may not/);
  assert.ok(fs.existsSync(path.join(s.dl, 'old.pdf')), 'the pending action did not run');
  const r = await turn(t2, s.chat.id, { text: 'are you there?' });
  assert.equal(r.done.status, 'done');
  const tools = s.up.seen.at(-1).body.messages.filter((m) => m.role === 'tool');
  assert.equal(tools.length, 2, 'history stays valid after recovery');
  await t2.app.close();
  await s.up.close();
});

test('shared folders: validated, stored as real paths, never the drive, home, or app data', async () => {
  const t = await boot();
  const ok = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-ok-'));
  const file = path.join(ok, 'f.txt');
  fs.writeFileSync(file, 'x');
  const bad = async (folders, re) => { const r = await t.call('PUT', '/api/settings', { folders }); assert.equal(r.status, 400, JSON.stringify(folders)); assert.match(r.body.error, re); };
  await bad(['/'], /whole drive/);
  await bad([os.homedir()], /home folder/);
  await bad(['relative/path'], /absolute/);
  await bad([path.join(ok, 'nope')], /not a folder/);
  await bad([file], /not a folder/);
  await bad([t.dataDir], /overlaps/);
  await bad([path.dirname(t.dataDir)], /overlaps|drive/);
  const link = path.join(os.tmpdir(), `muser-link-${process.pid}`);
  fs.symlinkSync(ok, link);
  const saved = await t.call('PUT', '/api/settings', { folders: [link, ok] });
  assert.deepEqual(saved.body.settings.folders, [fs.realpathSync(ok)], 'symlink resolved and deduped');
  fs.rmSync(link);
  await t.app.close();
});

test('Anthropic: tool_use is assembled from streamed JSON and tool_result goes back in the next request', async () => {
  let call = 0;
  const up = await fakeUpstream(({ res }) => {
    call++;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const ev = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    if (call === 1) {
      ev({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
      ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Let me look. ' } });
      ev({ type: 'content_block_stop', index: 0 });
      ev({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'list_files', input: {} } });
      ev({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: `{"path": "${dl.replace(/\\/g, '\\\\')}` } });
      ev({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"}' } });
      ev({ type: 'content_block_stop', index: 1 });
    } else {
      ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Two files.' } });
    }
    ev({ type: 'message_stop' });
    res.end();
  });
  const t = await boot({ env: { ANTHROPIC_BASE_URL: up.base, ANTHROPIC_API_KEY: 'k' } });
  const dl = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'muser-adl-')));
  fs.writeFileSync(path.join(dl, 'a.txt'), 'a');
  await t.call('PUT', '/api/settings', { folders: [dl] });
  const agent = (await t.call('GET', '/api/state')).body.agents[0];
  const chat = (await t.call('POST', '/api/chats', { agentId: agent.id })).body.chat;
  const r = await turn(t, chat.id, { text: 'look' });
  assert.equal(r.done.content, 'Two files.');
  assert.ok(up.seen[0].body.tools.every((x) => x.input_schema && x.name), 'tools use input_schema');
  const second = up.seen[1].body.messages;
  assert.deepEqual(second.map((m) => m.role), ['user', 'assistant', 'user']);
  assert.deepEqual(second[1].content.map((b) => b.type), ['text', 'tool_use']);
  assert.equal(second[1].content[1].input.path, dl);
  assert.equal(second[2].content[0].type, 'tool_result');
  assert.equal(second[2].content[0].tool_use_id, 'toolu_1');
  assert.match(second[2].content[0].content, /a\.txt/);
  await t.app.close();
  await up.close();
});
