'use strict';
// End-to-end UI tests: a real Chromium drives the real renderer against a real server process.
//   node test/e2e/run.js            offline scenarios (demo provider)
//   node test/e2e/run.js --live     also runs the live OpenAI scenarios (needs OPENAI_API_KEY)
const { chromium } = require('playwright');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startServer } = require('./server-proc');

const OUT = process.env.MUSER_SHOTS || path.join(__dirname, 'out');
const LIVE = process.argv.includes('--live');
fs.mkdirSync(OUT, { recursive: true });

const results = [];
let page;
let srv;
const pageErrors = [];

async function step(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    results.push({ name, ok: true, ms: Date.now() - t0 });
    console.log(`  ok   ${name} (${Date.now() - t0}ms)`);
  } catch (err) {
    results.push({ name, ok: false, err });
    console.log(`  FAIL ${name}\n       ${String(err.message).split('\n').slice(0, 4).join('\n       ')}`);
    try { await page.screenshot({ path: path.join(OUT, `FAIL-${name.replace(/\W+/g, '-')}.png`) }); } catch { /* ignore */ }
  }
}
const eq = (a, b, msg) => { if (a !== b) throw new Error(`${msg || 'expected equal'}: got ${JSON.stringify(a)}, wanted ${JSON.stringify(b)}`); };
const ok = (v, msg) => { if (!v) throw new Error(msg || 'assertion failed'); };
const shot = (name) => page.screenshot({ path: path.join(OUT, `${name}.png`) });

const lastBubble = () => page.locator('.msg.assistant .bubble').last();
const send = async (text) => { await page.fill('#input', text); await page.press('#input', 'Enter'); };
const waitDone = () => page.waitForSelector('.msg.assistant.last [data-act=retry]', { timeout: 20000 });
const openDrawer = async () => { if (!(await page.locator('#drawer').isVisible())) await page.click('#chats-btn'); await page.waitForSelector('#drawer .chat-list'); };
const load = async (url) => { await page.goto(url); await page.waitForSelector('html[data-ready]'); };

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-e2e-'));
  srv = await startServer({ dataDir, env: { MUSER_DEMO_DELAY_MS: '30' } });
  const browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1000, height: 664 }, deviceScaleFactor: 2 });
  page.on('pageerror', (e) => pageErrors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') pageErrors.push(`console: ${m.text()}`); });
  await load(srv.url);

  await step('first launch shows the seeded agent, empty state and demo notice', async () => {
    eq(await page.locator('#agent-chip .name').textContent(), 'Muser');
    eq(await page.locator('.empty h1').textContent(), 'Muser');
    ok(await page.locator('#notice').isVisible(), 'demo notice visible with no key');
    eq(await page.locator('.rail-agent').count(), 1);
    ok(await page.locator('#send-btn').isDisabled(), 'send disabled while empty');
    await shot('01-empty');
  });

  await step('live reply streams in pieces, then settles with Copy/Retry', async () => {
    await send('Hello there');
    await page.waitForSelector('.msg.user');
    await page.waitForSelector('.msg.assistant .bubble');
    ok(await page.locator('#stop-btn').isVisible(), 'Stop button replaces Send while streaming');
    await page.waitForFunction(() => (document.querySelector('.msg.assistant .bubble')?.textContent || '').length > 15);
    const a = (await lastBubble().textContent()).length;
    await page.waitForTimeout(300);
    const b = (await lastBubble().textContent()).length;
    ok(b > a, `text grew while streaming (${a} -> ${b})`);
    await waitDone();
    const text = await lastBubble().textContent();
    ok(text.includes('You said: "Hello there"'), 'reply used the message');
    eq(await page.locator('.bubble.caret').count(), 0, 'streaming caret is gone');
    ok(await page.locator('#send-btn').isVisible(), 'Send is back');
    eq(await page.locator('.msg.user').count(), 1, 'no duplicate user bubble');
    await shot('02-chat');
  });

  await step('Stop keeps the partial reply and offers Retry; Retry completes it', async () => {
    await send('Write something long please');
    await page.waitForFunction(() => (document.querySelectorAll('.msg.assistant .bubble')[1]?.textContent || '').length > 20);
    await page.click('#stop-btn');
    await page.waitForSelector('.msg.assistant.last .note');
    eq((await page.locator('.msg.assistant.last .note').textContent()).trim(), 'Stopped');
    const partial = await lastBubble().textContent();
    ok(partial.length > 10 && !partial.includes('Add an OpenAI'), `partial reply kept (${partial.length} chars)`);
    ok(await page.locator('#send-btn').isVisible(), 'composer is usable again');
    await shot('03-stopped');
    await page.click('.msg.assistant.last [data-act=retry]');
    await waitDone();
    ok((await lastBubble().textContent()).includes('Add an OpenAI'), 'retry produced the full reply');
    eq(await page.locator('.msg.assistant.last .note').count(), 0, 'Stopped note cleared');
    eq(await page.locator('.msg.assistant').count(), 2, 'retry replaced the reply instead of adding one');
  });

  await step('Esc also stops a reply', async () => {
    await send('Another long one');
    await page.waitForFunction(() => (document.querySelectorAll('.msg.assistant .bubble')[2]?.textContent || '').length > 10);
    await page.press('#input', 'Escape');
    await page.waitForSelector('.msg.assistant.last .note');
    eq((await page.locator('.msg.assistant.last .note').textContent()).trim(), 'Stopped');
  });

  await step('new agent flow: presets fill the form, create opens a fresh chat with that agent', async () => {
    await page.click('#new-agent-btn');
    await page.waitForSelector('.modal');
    ok(await page.locator('#save-agent').isDisabled(), 'Create is disabled until there is a name');
    await page.click('[data-preset=planner]');
    eq(await page.inputValue('#f-name'), 'Planner');
    ok((await page.inputValue('#f-instr')).startsWith('Turn goals into short'), 'preset instructions filled');
    await page.fill('#f-name', 'Planner Pro');
    await shot('04-new-agent');
    await page.click('#save-agent');
    await page.waitForSelector('.modal', { state: 'detached' });
    eq(await page.locator('.rail-agent').count(), 2);
    eq(await page.locator('#agent-chip .name').textContent(), 'Planner Pro');
    eq(await page.locator('.empty h1').textContent(), 'Planner Pro');
    await send('plan my week');
    await waitDone();
    const reply = await lastBubble().textContent();
    ok(reply.includes('Planner Pro') && reply.includes('Turn goals into short'), 'new agent answers with its own instructions');
  });

  await step('editing instructions applies to the very next reply in the same chat', async () => {
    await page.click('#agent-chip');
    await page.waitForSelector('.modal');
    ok(await page.locator('#save-agent').isDisabled(), 'Save disabled until something changes');
    await page.fill('#f-instr', 'Speak like a pirate at all times.');
    ok((await page.textContent('.field em:not(:empty)')) !== null);
    await page.click('#save-agent');
    await page.waitForSelector('.modal', { state: 'detached' });
    ok((await page.locator('#toast').textContent()).includes('Saved'), 'toast confirms the save');
    await send('ahoy');
    await waitDone();
    ok((await lastBubble().textContent()).includes('Speak like a pirate at all times.'), 'edited instructions used in an existing chat');
    await page.click('#agent-chip');
    eq(await page.inputValue('#f-instr'), 'Speak like a pirate at all times.', 'instructions persisted');
    await page.keyboard.press('Escape');
    await page.waitForSelector('.modal', { state: 'detached' });
  });

  await step('instructions over the limit are blocked; closing with edits asks before discarding', async () => {
    await page.click('#agent-chip');
    await page.waitForSelector('.modal');
    await page.fill('#f-instr', 'x'.repeat(8001));
    ok(await page.locator('#save-agent').isDisabled(), 'Save disabled over limit');
    ok(await page.locator('.field em.over').count() === 1, 'counter turns red');
    await page.keyboard.press('Escape');
    await page.waitForSelector('.modal[aria-label="Discard changes?"]');
    await page.click('.modal[aria-label="Discard changes?"] .btn:not(.danger)'); // Cancel keeps editing
    ok(await page.locator('#f-instr').isVisible(), 'still editing');
    await page.keyboard.press('Escape');
    await page.click('.modal[aria-label="Discard changes?"] .btn.danger');
    await page.waitForSelector('.modal', { state: 'detached' });
  });

  await step('Chats drawer groups, searches, renames, pins and deletes', async () => {
    await openDrawer();
    await shot('05-drawer');
    const count = await page.locator('#drawer .chat-item').count();
    ok(count === 2, `two saved chats listed, got ${count}`);
    eq(await page.locator('#drawer .group-label').first().textContent(), 'Today');
    const first = page.locator('#drawer .chat-item').first();
    await first.hover();
    await first.locator('[data-act=rename]').click();
    await page.fill('#drawer .rename', 'Weekly plan');
    await page.press('#drawer .rename', 'Enter');
    await page.waitForSelector('#drawer .t:text("Weekly plan")');
    const row = page.locator('#drawer .chat-item', { hasText: 'Weekly plan' });
    await row.hover();
    await row.locator('[data-act=pin]').click();
    await page.waitForSelector('#drawer .group-label:text("Pinned")');
    eq(await page.locator('#drawer .group-label').first().textContent(), 'Pinned');
    await page.fill('#drawer input[type=search]', 'hello');
    eq(await page.locator('#drawer .chat-item').count(), 1, 'search filters by title');
    await page.fill('#drawer input[type=search]', 'zzz');
    ok((await page.locator('.list-empty').textContent()).includes('No chats match'));
    await page.fill('#drawer input[type=search]', '');
    await page.keyboard.press('Escape');
    await page.waitForSelector('#drawer', { state: 'hidden' });
  });

  await step('opening an older chat restores its messages and agent', async () => {
    await openDrawer();
    await page.locator('#drawer .chat-item', { hasText: 'Hello there' }).locator('.body').click();
    await page.waitForSelector('#drawer', { state: 'hidden' });
    eq(await page.locator('#agent-chip .name').textContent(), 'Muser');
    eq(await page.locator('.msg.user').count(), 3);
    ok((await page.locator('.msg.user').first().textContent()).includes('Hello there'));
    await shot('06-older-chat');
  });

  await step('keyboard: Ctrl+N starts a new chat; the empty chat is not saved until you send', async () => {
    await page.keyboard.press('Control+n');
    await page.waitForSelector('.empty');
    await openDrawer();
    eq(await page.locator('#drawer .chat-item').count(), 2, 'a draft chat is not listed');
    await page.keyboard.press('Escape');
  });

  await step('model output cannot inject markup', async () => {
    await send('<img src=x onerror="window.__pwn=1"> **bold** `code`');
    await waitDone();
    eq(await page.evaluate(() => window.__pwn), undefined, 'no script ran');
    eq(await page.locator('#thread img').count(), 0, 'no <img> element created');
    ok((await lastBubble().textContent()).includes('<img src=x'), 'markup shown as text');
  });

  await step('settings: key fields are write-only and the choice saves', async () => {
    await page.click('#settings-btn');
    await page.waitForSelector('.modal[aria-label=Settings]');
    eq(await page.getAttribute('.modal input[aria-label="OpenAI API key"]', 'type'), 'password');
    await page.click('.seg [data-provider=demo]');
    await page.click('#save-settings');
    await page.waitForSelector('.modal', { state: 'detached' });
    ok((await page.locator('#toast').textContent()).includes('Settings saved'));
  });

  // ---- restart behaviour ------------------------------------------------------------------
  let snapshot;
  await step('graceful restart: every chat, title, pin and message is still there', async () => {
    snapshot = await page.evaluate(async () => {
      const token = document.querySelector('meta[name=muser-token]').content;
      const st = await (await fetch('/api/state', { headers: { 'x-muser-token': token } })).json();
      return { chats: st.chats.map((c) => [c.title, c.pinned, c.messageCount]), agents: st.agents.map((a) => a.name) };
    });
    await srv.stop();
    const t0 = Date.now();
    srv = await startServer({ dataDir, env: { MUSER_DEMO_DELAY_MS: '30' } });
    await load(srv.url);
    const boot = Date.now() - t0;
    ok(boot < 4000, `restart to interactive in ${boot}ms`);
    const after = await page.evaluate(async () => {
      const token = document.querySelector('meta[name=muser-token]').content;
      const st = await (await fetch('/api/state', { headers: { 'x-muser-token': token } })).json();
      return { chats: st.chats.map((c) => [c.title, c.pinned, c.messageCount]), agents: st.agents.map((a) => a.name) };
    });
    eq(JSON.stringify(after), JSON.stringify(snapshot), 'state identical after restart');
    ok(await page.locator('.msg.user').count() > 0, 'the most recent chat reopened with its messages');
    await shot('07-after-restart');
  });

  await step('kill -9 mid-reply: restart immediately, partial text kept, marked interrupted, Retry works', async () => {
    const errorsBefore = pageErrors.length;
    await srv.kill9();
    srv = await startServer({ dataDir, env: { MUSER_DEMO_DELAY_MS: '90' } });
    await load(srv.url);
    await send('Tell me a very long story');
    await page.waitForFunction(() => (document.querySelector('.msg.assistant.last .bubble')?.textContent || '').length > 25);
    await page.waitForTimeout(900); // let the periodic save land
    const seen = await lastBubble().textContent();
    await srv.kill9(); // the app dies hard while replying
    const t0 = Date.now();
    srv = await startServer({ dataDir, env: { MUSER_DEMO_DELAY_MS: '5' } });
    await load(srv.url);
    ok(Date.now() - t0 < 4000, `immediate restart took ${Date.now() - t0}ms`);
    // Killing the server on purpose cuts the stream; only those network errors are expected here.
    const expected = /ERR_(INCOMPLETE_CHUNKED_ENCODING|CONNECTION_REFUSED|CONNECTION_RESET|EMPTY_RESPONSE)/;
    pageErrors.splice(errorsBefore, pageErrors.length, ...pageErrors.slice(errorsBefore).filter((e) => !expected.test(e)));
    eq((await page.locator('.msg.assistant.last .note').textContent()).trim(), 'Reply was interrupted');
    const kept = await lastBubble().textContent();
    ok(kept.length > 10 && seen.startsWith(kept.slice(0, 10)), `partial reply survived (${kept.length} chars)`);
    ok(await page.locator('.msg.user').last().textContent() === 'Tell me a very long story', 'the question survived');
    await shot('08-interrupted');
    await page.click('.msg.assistant.last [data-act=retry]');
    await waitDone();
    ok((await lastBubble().textContent()).includes('Add an OpenAI'), 'retry finished the reply');
    eq(await page.locator('.msg.assistant.last .note').count(), 0);
  });

  await step('deleting a chat and an agent removes them for good (also after restart)', async () => {
    await openDrawer();
    const before = await page.locator('#drawer .chat-item').count();
    const row = page.locator('#drawer .chat-item').last();
    await row.hover();
    await row.locator('[data-act=delete]').click();
    await page.click('.modal .btn.danger.solid');
    await page.waitForSelector('.modal', { state: 'detached' });
    await openDrawer();
    // The dialog closes before the delete request finishes, so wait for the list to catch up.
    await page.waitForFunction((n) => document.querySelectorAll('#drawer .chat-item').length === n, before - 1, { timeout: 5000 });
    await page.keyboard.press('Escape');
    await page.click('.rail-agent >> nth=1');
    await page.click('#agent-chip');
    await page.click('#delete-agent');
    await page.click('.modal[aria-label^="Delete"] .btn.danger.solid');
    await page.waitForSelector('.modal', { state: 'detached' });
    eq(await page.locator('.rail-agent').count(), 1);
    await srv.stop();
    srv = await startServer({ dataDir, env: { MUSER_DEMO_DELAY_MS: '30' } });
    await load(srv.url);
    eq(await page.locator('.rail-agent').count(), 1);
  });

  await step('narrow window keeps the layout usable (no horizontal scroll)', async () => {
    await page.setViewportSize({ width: 520, height: 700 });
    await page.waitForTimeout(100);
    ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'no horizontal overflow');
    await shot('09-narrow');
    await page.setViewportSize({ width: 1000, height: 664 });
  });

  if (LIVE) await liveScenarios(dataDir);

  await step('no console or page errors during the whole run', async () => {
    ok(pageErrors.length === 0, pageErrors.join(' | '));
  });

  await browser.close();
  await srv.stop();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} UI checks passed. Screenshots: ${OUT}`);
  process.exit(failed.length ? 1 : 0);
}

// Real model, real network: proves streaming, instructions, stop and retry against OpenAI.
async function liveScenarios() {
  ok(process.env.OPENAI_API_KEY, '--live needs OPENAI_API_KEY');
  await srv.stop();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-live-'));
  const clean = { OPENAI_API_KEY: process.env.OPENAI_API_KEY };
  srv = await startServer({ dataDir, env: clean });
  await load(srv.url);
  await step('LIVE: provider resolves to OpenAI from the environment, no demo notice', async () => {
    ok(!(await page.locator('#notice').isVisible()), 'no demo notice');
  });
  await step('LIVE: real model streams a reply token by token', async () => {
    // Record every size the reply bubble takes on, so we can see it grow in many steps.
    await page.evaluate(() => {
      window.__lens = [];
      new MutationObserver(() => {
        const b = [...document.querySelectorAll('.msg.assistant .bubble')].pop();
        const n = b ? (b.querySelector('.typing') ? 0 : b.textContent.length) : 0;
        if (n && window.__lens[window.__lens.length - 1] !== n) window.__lens.push(n);
      }).observe(document.querySelector('#thread'), { childList: true, subtree: true, characterData: true });
    });
    await send('Count from 1 to 30, separated by single spaces. Output only the numbers.');
    await waitDone();
    const final = await lastBubble().textContent();
    ok(/\b30\b/.test(final), `model counted to 30: ${final.slice(0, 80)}`);
    const lens = await page.evaluate(() => window.__lens);
    ok(lens.length >= 4, `reply grew in ${lens.length} visible steps: ${lens.join(',')}`);
    console.log(`       (live reply arrived in ${lens.length} incremental steps, ${final.length} chars)`);
    await shot('live-01-reply');
  });
  await step('LIVE: edited instructions change the real model output', async () => {
    await page.click('#agent-chip');
    await page.fill('#f-instr', 'Always end every reply with the exact word PINEAPPLE on its own line.');
    await page.click('#save-agent');
    await page.waitForSelector('.modal', { state: 'detached' });
    await send('Say hi in five words.');
    await waitDone();
    ok((await lastBubble().textContent()).toUpperCase().includes('PINEAPPLE'), `instruction followed: ${await lastBubble().textContent()}`);
  });
  await step('LIVE: Stop cuts a long real reply, Retry regenerates it', async () => {
    await send('Write a 600 word essay about rivers.');
    await page.waitForFunction(() => (document.querySelector('.msg.assistant.last .bubble')?.textContent || '').length > 80, null, { timeout: 20000 });
    await page.click('#stop-btn');
    await page.waitForSelector('.msg.assistant.last .note');
    const partial = (await lastBubble().textContent()).length;
    ok(partial > 40 && partial < 3000, `partial reply kept (${partial} chars)`);
    await page.click('.msg.assistant.last [data-act=retry]');
    await page.waitForFunction(() => (document.querySelector('.msg.assistant.last .bubble')?.textContent || '').length > 80, null, { timeout: 20000 });
    await page.click('#stop-btn');
    await page.waitForSelector('.msg.assistant.last .note');
  });
  await step('LIVE: bad key shows a readable, retryable error without leaking the key', async () => {
    await page.click('#settings-btn');
    await page.fill('.modal input[aria-label="OpenAI API key"]', 'sk-invalid-test-key-123');
    await page.click('.seg [data-provider=openai]');
    await page.click('#save-settings');
    await page.waitForSelector('.modal', { state: 'detached' });
    await send('hello');
    await page.waitForSelector('.errbox', { timeout: 20000 });
    const msg = await page.locator('.errbox').textContent();
    ok(/key was rejected/i.test(msg) && !msg.includes('sk-invalid-test-key-123'), `error text: ${msg}`);
    ok(await page.locator('.msg.assistant.last [data-act=retry]').isVisible(), 'Retry offered');
    await shot('live-02-error');
  });
}

main().catch((err) => { console.error(err); try { srv && srv.child.kill('SIGKILL'); } catch { /* ignore */ } process.exit(1); });
