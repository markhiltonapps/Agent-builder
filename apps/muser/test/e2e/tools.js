'use strict';
// UI tests for real tool use and the approval card.
//   node test/e2e/tools.js           scripted model (deterministic)
//   node test/e2e/tools.js --live    also drives the real OpenAI API against a real temp folder
const { chromium } = require('playwright');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startServer } = require('./server-proc');
const { fakeUpstream, scriptedOpenAI } = require('../helpers');

const OUT = process.env.MUSER_SHOTS || path.join(__dirname, 'out');
const LIVE = process.argv.includes('--live');
fs.mkdirSync(OUT, { recursive: true });

const results = [];
let page;
let srv;
let dl;
const pageErrors = [];

async function step(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ok   ${name} (${Date.now() - t0}ms)`);
  } catch (err) {
    results.push({ name, ok: false });
    console.log(`  FAIL ${name}\n       ${String(err.message).split('\n').slice(0, 5).join('\n       ')}`);
    try { await page.screenshot({ path: path.join(OUT, `FAIL-${name.replace(/\W+/g, '-').slice(0, 60)}.png`) }); } catch { /* ignore */ }
  }
}
const eq = (a, b, m) => { if (a !== b) throw new Error(`${m || 'not equal'}: got ${JSON.stringify(a)}, wanted ${JSON.stringify(b)}`); };
const ok = (v, m) => { if (!v) throw new Error(m || 'assertion failed'); };
const shot = (n) => page.screenshot({ path: path.join(OUT, `${n}.png`) });
const send = async (text) => { await page.fill('#input', text); await page.press('#input', 'Enter'); };
const card = () => page.locator('.approval');
const settled = () => page.waitForSelector('.msg.assistant.last [data-act=retry]', { timeout: 20000 });
const exists = (name) => fs.existsSync(path.join(dl, name));
const load = async (url) => { await page.goto(url); await page.waitForSelector('html[data-ready]'); };
const newChat = async () => { await page.keyboard.press('Control+n'); await page.waitForSelector('.empty'); };

// The scripted "model": it reasons from the real tool results it is shown, like a real one would.
function brain(body) {
  const msgs = body.messages;
  let lastUserIdx = -1;
  msgs.forEach((m, i) => { if (m.role === 'user') lastUserIdx = i; });
  const ask = msgs[lastUserIdx].content;
  const after = msgs.slice(lastUserIdx + 1);
  const tools = after.filter((m) => m.role === 'tool');
  const lastTool = tools[tools.length - 1];
  const call = (name, args) => ({ tools: [{ name, args }] });
  const resultOf = (m) => { try { return JSON.parse(m.content); } catch { return {}; } };

  if (/organize/.test(ask)) {
    if (!tools.length) return call('list_files', { path: dl });
    if (tools.length === 1) {
      const cutoff = Date.now() - 180 * 864e5;
      const old = resultOf(tools[0]).entries.filter((e) => e.type === 'file' && Date.parse(e.modified) < cutoff).map((e) => path.join(dl, e.path));
      return call('trash_files', { paths: old });
    }
    return { text: /denied/.test(lastTool.content) ? 'Okay, I left everything where it is.' : `Done. I moved ${resultOf(lastTool).trashed.length} old files to Trash.` };
  }
  if (/deny me/.test(ask)) return lastTool ? { text: 'Understood, nothing was changed.' } : call('trash_files', { paths: [path.join(dl, 'recent.pdf')] });
  const mk = /make (\w+)/.exec(ask);
  if (mk) return lastTool ? { text: `Folder ${mk[1]} is ready.` } : call('make_folder', { path: path.join(dl, mk[1]) });
  if (/stop test/.test(ask)) return lastTool && !/cancelled/.test(lastTool.content) ? { text: 'Done.' } : call('trash_files', { paths: [path.join(dl, 'recent.pdf')] });
  if (/escape/.test(ask)) return lastTool ? { text: 'I am not allowed to do that.' } : call('move_files', { moves: [{ from: '/etc/hostname', to: path.join(dl, 'stolen') }] });
  if (/long story/.test(ask)) return lastTool && !/cancelled|may or may not/.test(lastTool.content) ? { text: 'Resumed.' } : call('trash_files', { paths: [path.join(dl, 'recent.pdf')] });
  return { text: 'Hello.' };
}

function seedDownloads() {
  dl = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'Downloads-')));
  const ago = (days) => new Date(Date.now() - days * 864e5);
  for (const [name, days] of [['tax-2024.pdf', 400], ['old-installer.zip', 300], ['recent.pdf', 2]]) {
    fs.writeFileSync(path.join(dl, name), name);
    fs.utimesSync(path.join(dl, name), ago(days), ago(days));
  }
}

async function main() {
  seedDownloads();
  const up = await fakeUpstream(scriptedOpenAI([(body) => brain(body)]));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-tools-e2e-'));
  const env = { OPENAI_BASE_URL: up.base, OPENAI_API_KEY: 'sk-fake' };
  srv = await startServer({ dataDir, env });
  const browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1000, height: 664 }, deviceScaleFactor: 2 });
  page.on('pageerror', (e) => pageErrors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') pageErrors.push(`console: ${m.text()}`); });
  await load(srv.url);

  await step('sharing a folder: bad paths are refused inline, a real one is listed', async () => {
    await page.click('#settings-btn');
    const before = pageErrors.length;
    await page.fill('#folder-input', '/');
    await page.click('#folder-add');
    await page.waitForSelector('.folder-add ~ .err-line:not(:empty)');
    // The browser logs the deliberate 400 for the invalid path; that one is expected.
    pageErrors.splice(before, pageErrors.length, ...pageErrors.slice(before).filter((e) => !/status of 400/.test(e)));
    ok((await page.locator('.folder-add ~ .err-line').textContent()).includes('whole drive'));
    await page.fill('#folder-input', dl);
    await page.click('#folder-add');
    await page.waitForSelector(`[data-remove-folder="${dl}"]`);
    await shot('10-folders');
    await page.keyboard.press('Escape');
    await page.waitForSelector('.modal', { state: 'detached' });
  });

  await step('reference scenario: read runs at once, trashing asks first, nothing changes until Allow', async () => {
    await send("My downloads folder is a mess - organize it and trash anything older than 6 months.");
    await card().waitFor({ timeout: 15000 });
    ok((await page.locator('.activity').first().textContent()).includes('Looked through'), 'the read-only step ran without asking');
    eq(await card().locator('.ap-head span').last().textContent(), 'Allow Muser to move 2 items to Trash?');
    eq(await card().locator('.ap-summary .k').textContent(), 'Task summary');
    ok((await card().locator('.ap-summary .v').textContent()).startsWith('Move 2 items in'), 'summary line');
    eq(await card().locator('.ap-btn').allTextContents().then((a) => a.join('|')), 'Allow|Always allow|Deny');
    ok(exists('tax-2024.pdf') && exists('old-installer.zip'), 'files untouched while the card is open');
    ok(await page.locator('#stop-btn').isVisible(), 'turn is still running, Stop available');
    await shot('11-approval-collapsed');
    await card().locator('.ap-summary').click();
    const items = await card().locator('.ap-items li').allTextContents();
    eq(items.length, 2);
    ok(items.some((i) => i.endsWith('/tax-2024.pdf')) && items.some((i) => i.endsWith('/old-installer.zip')) && !items.some((i) => i.includes('recent')), 'exactly the old files are listed');
    await shot('12-approval-expanded');
    await card().locator('[data-decision=allow]').click();
    await settled();
    ok(!exists('tax-2024.pdf') && !exists('old-installer.zip') && exists('recent.pdf'), 'old files gone, recent kept');
    eq(await card().count(), 0, 'card is gone after the decision');
    ok((await page.locator('.activity[data-status=done]').last().textContent()).includes('Moved 2 items to Trash'));
    ok((await page.locator('.msg.assistant .bubble').last().textContent()).includes('moved 2 old files to Trash'));
    await shot('13-after-allow');
    const manifest = fs.readdirSync(path.join(dataDir, 'trash')).flatMap((d) => fs.readFileSync(path.join(dataDir, 'trash', d, 'manifest.jsonl'), 'utf8').trim().split('\n'));
    eq(manifest.length, 2, 'both files are in the recoverable trash with a manifest');
  });

  await step('the finished action is a quiet, expandable record', async () => {
    const rec = page.locator('details.activity[data-status=done]');
    eq(await rec.count(), 1);
    await rec.locator('summary').click();
    eq(await rec.locator('li').count(), 2);
  });

  await step('Deny keeps the file and the chat carries on', async () => {
    await newChat();
    await send('deny me please');
    await card().waitFor();
    await card().locator('[data-decision=deny]').click();
    await settled();
    ok(exists('recent.pdf'), 'file untouched');
    ok((await page.locator('.activity').last().textContent()).startsWith('Denied:'));
    ok((await page.locator('.msg.assistant .bubble').last().textContent()).includes('nothing was changed'));
  });

  await step('Always allow: no card next time, shown in the agent editor, revocable', async () => {
    await newChat();
    await send('make Alpha');
    await card().waitFor();
    await card().locator('[data-decision=always]').click();
    await settled();
    ok(exists('Alpha'));
    await newChat();
    await send('make Beta');
    await settled();
    eq(await card().count(), 0, 'no card once always-allowed');
    ok(exists('Beta'));
    await page.click('#agent-chip');
    await page.waitForSelector('#allow-box [data-revoke=make_folder]');
    await shot('14-always-allowed');
    await page.click('[data-revoke=make_folder]');
    ok(!(await page.locator('#save-agent').isDisabled()), 'revoking is a change to save');
    await page.click('#save-agent');
    await page.waitForSelector('.modal', { state: 'detached' });
    await newChat();
    await send('make Gamma');
    await card().waitFor();
    await card().locator('[data-decision=deny]').click();
    await settled();
    ok(!exists('Gamma'), 'asks again after revoking');
  });

  await step('Stop with a card open cancels it and changes nothing; Retry asks again', async () => {
    await newChat();
    await send('stop test');
    await card().waitFor();
    await page.click('#stop-btn');
    await settled();
    ok(exists('recent.pdf'));
    eq(await card().count(), 0);
    ok((await page.locator('.activity').last().textContent()).startsWith('Cancelled:'));
    eq((await page.locator('.msg.assistant.last .note').textContent()).trim(), 'Stopped');
    await page.click('.msg.assistant.last [data-act=retry]');
    await card().waitFor({ timeout: 15000 });
    await card().locator('[data-decision=deny]').click();
    await settled();
    ok(exists('recent.pdf'));
  });

  await step('a request outside the shared folder is refused with no card', async () => {
    await newChat();
    await send('please escape');
    await settled();
    eq(await card().count(), 0);
    ok(/outside the folders/.test(await page.locator('.activity.bad').first().textContent()), 'the refusal is visible');
    ok(!exists('stolen'));
  });

  await step('kill -9 with a card open: restart shows it cancelled, file safe, Retry re-asks', async () => {
    await newChat();
    await send('long story please');
    await card().waitFor();
    await page.waitForTimeout(300);
    const before = pageErrors.length;
    await srv.kill9();
    srv = await startServer({ dataDir, env });
    await load(srv.url);
    const expected = /ERR_(INCOMPLETE_CHUNKED_ENCODING|CONNECTION_REFUSED|CONNECTION_RESET|EMPTY_RESPONSE)/;
    pageErrors.splice(before, pageErrors.length, ...pageErrors.slice(before).filter((e) => !expected.test(e)));
    eq(await card().count(), 0, 'no dead card after restart');
    ok((await page.locator('.activity').last().textContent()).startsWith('Cancelled:'));
    ok(exists('recent.pdf'), 'nothing ran');
    await shot('15-after-crash');
    await page.click('.msg.assistant.last [data-act=retry]');
    await card().waitFor({ timeout: 15000 });
    await card().locator('[data-decision=deny]').click();
    await settled();
  });

  await step('the card fits a narrow window', async () => {
    await newChat();
    await send('deny me please');
    await card().waitFor();
    await page.setViewportSize({ width: 480, height: 700 });
    ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'no horizontal overflow');
    ok(await page.evaluate(() => { const r = document.querySelector('.approval').getBoundingClientRect(); return r.left >= 0 && r.right <= window.innerWidth; }), 'card inside the window');
    await shot('16-card-narrow');
    await page.setViewportSize({ width: 1000, height: 664 });
    await card().locator('[data-decision=deny]').click();
    await settled();
  });

  await step('keyboard: the card is reachable by Tab and Enter on a focused button works; Enter in the composer never approves', async () => {
    await newChat();
    await send('deny me please');
    await card().waitFor();
    await page.focus('#input');
    await page.keyboard.press('Enter');
    ok(await card().count() === 1, 'Enter in the composer did not answer the card');
    await card().locator('[data-decision=deny]').focus();
    await page.keyboard.press('Enter');
    await settled();
    ok(exists('recent.pdf'));
  });

  if (LIVE) await liveScenarios(env, dataDir);

  await step('no console or page errors during the whole run', async () => {
    ok(pageErrors.length === 0, pageErrors.join(' | '));
  });
  await browser.close();
  await srv.stop();
  await up.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} tool-use UI checks passed. Screenshots: ${OUT}`);
  process.exit(failed.length ? 1 : 0);
}

// Real OpenAI model, real files in a real temp folder, real clicks on the card.
async function liveScenarios() {
  ok(process.env.OPENAI_API_KEY, '--live needs OPENAI_API_KEY');
  await srv.stop();
  const liveData = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-live-tools-'));
  const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'LiveDocs-')));
  for (const n of ['report-2024.txt', 'notes.txt', 'photo-list.txt']) fs.writeFileSync(path.join(folder, n), `${n} content`);
  srv = await startServer({ dataDir: liveData, env: { OPENAI_API_KEY: process.env.OPENAI_API_KEY } });
  await load(srv.url);
  await page.click('#settings-btn');
  await page.fill('#folder-input', folder);
  await page.click('#folder-add');
  await page.waitForSelector(`[data-remove-folder="${folder}"]`);
  await page.keyboard.press('Escape');
  await page.waitForSelector('.modal', { state: 'detached' });

  // Answer every card with `decision` until the turn finishes. Returns the card titles seen.
  async function runTurn(text, decision) {
    await send(text);
    const titles = [];
    const deadline = Date.now() + 60000;
    for (;;) {
      if (Date.now() > deadline) throw new Error(`turn did not finish; titles so far: ${titles.join(' / ')}`);
      if (await card().count()) {
        titles.push(await card().locator('.ap-head span').last().textContent());
        await card().locator(`[data-decision=${decision}]`).click();
        await page.waitForTimeout(150);
      } else if (await page.locator('.msg.assistant.last [data-act=retry]').count()) break;
      else await page.waitForTimeout(120);
    }
    return titles;
  }

  await step('LIVE: the real model lists files and asks before moving one', async () => {
    const titles = await runTurn(`Look in ${folder} and move report-2024.txt into a new subfolder called Archive.`, 'allow');
    ok(titles.length >= 1, 'at least one approval card was shown');
    ok(!fs.existsSync(path.join(folder, 'report-2024.txt')) && fs.existsSync(path.join(folder, 'Archive', 'report-2024.txt')), `file moved into Archive (cards: ${titles.join(' / ')})`);
    ok(fs.existsSync(path.join(folder, 'notes.txt')) && fs.existsSync(path.join(folder, 'photo-list.txt')), 'other files untouched');
    console.log(`       (live cards: ${titles.join(' | ')})`);
    await shot('live-10-moved');
  });
  await step('LIVE: Deny stops a real model from deleting a file', async () => {
    await newChat();
    const titles = await runTurn(`Please move notes.txt to the Trash.`, 'deny');
    ok(titles.length >= 1, 'a card was shown');
    ok(fs.existsSync(path.join(folder, 'notes.txt')), 'file still there after Deny');
    await shot('live-11-denied');
  });
  await step('LIVE: the real model cannot be talked outside the shared folder', async () => {
    await newChat();
    const sentinel = path.join(os.tmpdir(), `muser-outside-${process.pid}.txt`);
    fs.writeFileSync(sentinel, 'outside');
    await runTurn(`Move the file ${sentinel} into ${folder}.`, 'allow');
    ok(fs.existsSync(sentinel), 'a file outside the shared folder was not touched');
    fs.rmSync(sentinel);
  });
}

main().catch((err) => { console.error(err); try { srv && srv.child.kill('SIGKILL'); } catch { /* ignore */ } process.exit(1); });
