'use strict';
// Phone test: a touch device on the network opens the LAN link (with the key) and uses the app by tapping.
//   node test/e2e/mobile.js
const { chromium, devices } = require('playwright');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startServer } = require('./server-proc');
const { fakeUpstream, scriptedOpenAI } = require('../helpers');

const OUT = process.env.MUSER_SHOTS || path.join(__dirname, 'out');
fs.mkdirSync(OUT, { recursive: true });
const lanIp = Object.values(os.networkInterfaces()).flat().find((a) => a && a.family === 'IPv4' && !a.internal)?.address;
if (!lanIp) { console.log('No network address on this machine; cannot run the phone test.'); process.exit(0); }

const results = [];
let page;
const pageErrors = [];
async function step(name, fn) {
  const t0 = Date.now();
  try { await fn(); results.push({ name, ok: true }); console.log(`  ok   ${name} (${Date.now() - t0}ms)`); }
  catch (err) {
    results.push({ name, ok: false });
    console.log(`  FAIL ${name}\n       ${String(err.message).split('\n').slice(0, 5).join('\n       ')}`);
    try { await page.screenshot({ path: path.join(OUT, `FAIL-mobile-${name.replace(/\W+/g, '-').slice(0, 50)}.png`) }); } catch { /* ignore */ }
  }
}
const eq = (a, b, m) => { if (a !== b) throw new Error(`${m || 'not equal'}: got ${JSON.stringify(a)}, wanted ${JSON.stringify(b)}`); };
const ok = (v, m) => { if (!v) throw new Error(m || 'assertion failed'); };
const shot = (n) => page.screenshot({ path: path.join(OUT, `${n}.png`) });
const tap = (sel) => page.tap(sel);
const settled = () => page.waitForSelector('.msg.assistant.last [data-act=retry]', { timeout: 20000 });
const noOverflow = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
const inViewport = (sel) => page.evaluate((s) => { const r = document.querySelector(s).getBoundingClientRect(); return r.left >= -0.5 && r.right <= window.innerWidth + 0.5 && r.top >= -0.5 && r.bottom <= window.innerHeight + 0.5; }, sel);

async function runDevice(label, descriptor, browser, lanUrl, folder, dataDir) {
  // Chromium with the phone's screen, touch and user agent (WebKit itself is not installed here).
  const { defaultBrowserType, ...ctxOpts } = descriptor;
  const ctx = await browser.newContext({ ...ctxOpts, deviceScaleFactor: 2 });
  page = await ctx.newPage();
  page.on('pageerror', (e) => pageErrors.push(`${label} pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') pageErrors.push(`${label} console: ${m.text()}`); });
  const tag = label.replace(/\W+/g, '').toLowerCase();

  await step(`${label}: the link with the key opens the app and clears the key from the address`, async () => {
    await page.goto(lanUrl);
    await page.waitForSelector('html[data-ready]');
    ok(!page.url().includes('key='), `address bar is clean: ${page.url()}`);
    ok(await page.evaluate(() => 'ontouchstart' in window || navigator.maxTouchPoints > 0), 'touch device');
    await shot(`20-${tag}-empty`);
  });

  await step(`${label}: fits the screen, text fields are 16px+ (no iOS zoom), targets are finger-sized`, async () => {
    ok(await noOverflow(), 'no horizontal scroll');
    const fs16 = await page.evaluate(() => parseFloat(getComputedStyle(document.querySelector('#input')).fontSize));
    ok(fs16 >= 16, `composer font ${fs16}px`);
    const sizes = await page.evaluate(() => ['#chats-btn', '#send-btn', '#plus-btn', '#new-agent-btn', '#settings-btn'].map((s) => { const r = document.querySelector(s).getBoundingClientRect(); return [s, Math.round(r.width), Math.round(r.height)]; }));
    for (const [s, w, h] of sizes) ok(w >= 34 && h >= 34, `${s} is ${w}x${h}`);
    ok(await inViewport('#composer'), 'composer is on screen');
  });

  await step(`${label}: share a folder by tapping through Settings`, async () => {
    await tap('#settings-btn');
    await page.waitForSelector('.modal[aria-label=Settings]');
    ok(await inViewport('.modal') || await page.evaluate(() => document.querySelector('.modal').scrollHeight > 0), 'settings sheet is visible');
    await page.fill('#folder-input', folder);
    await tap('#folder-add');
    await page.waitForSelector(`[data-remove-folder="${folder}"]`);
    await shot(`21-${tag}-settings`);
    await page.evaluate(() => document.querySelector('.modal').closest('.modal-back').dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
    await page.waitForSelector('.modal', { state: 'detached' });
  });

  await step(`${label}: send a message by tapping; the reply streams in; approval card works by touch`, async () => {
    fs.writeFileSync(path.join(folder, `old-${tag}.txt`), 'bye');
    await page.fill('#input', `trash old-${tag}.txt`);
    await tap('#send-btn');
    await page.waitForSelector('.approval', { timeout: 15000 });
    ok(fs.existsSync(path.join(folder, `old-${tag}.txt`)), 'untouched while the card is open');
    ok(await noOverflow(), 'card does not overflow');
    ok(await inViewport('.approval'), 'card is fully on screen');
    const btn = await page.locator('.approval .ap-btn').first().boundingBox();
    ok(btn.height >= 36, `Allow button is ${btn.height}px tall`);
    const always = await page.locator('.approval .ap-btn').nth(1).boundingBox();
    ok(always.height < 46, `"Always allow" stays on one line (${always.height}px tall)`);
    await shot(`22-${tag}-card`);
    await tap('.approval [data-decision=allow]');
    await settled();
    ok(!fs.existsSync(path.join(folder, `old-${tag}.txt`)), 'file was trashed after tapping Allow');
    await shot(`23-${tag}-done`);
  });

  await step(`${label}: Stop by tap cancels a waiting card`, async () => {
    fs.writeFileSync(path.join(folder, `keep-${tag}.txt`), 'stay');
    await page.fill('#input', `trash keep-${tag}.txt`);
    await tap('#send-btn');
    await page.waitForSelector('.approval');
    await tap('#stop-btn');
    await settled();
    ok(fs.existsSync(path.join(folder, `keep-${tag}.txt`)), 'file kept');
    ok((await page.locator('.activity').last().textContent()).startsWith('Cancelled:'));
  });

  await step(`${label}: Chats drawer is full-width, and rename/pin/delete are tappable without hover`, async () => {
    await tap('#chats-btn');
    await page.waitForSelector('#drawer .chat-item');
    await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished))); // let it finish sliding in
    ok(await inViewport('#drawer'), 'drawer inside the screen');
    const acts = await page.evaluate(() => [...document.querySelector('#drawer .chat-item').querySelectorAll('.row-actions .act')].map((b) => { const r = b.getBoundingClientRect(); return { w: r.width, h: r.height, shown: getComputedStyle(b.parentElement).display !== 'none' }; }));
    eq(acts.length, 3, 'three row actions');
    ok(acts.every((a) => a.shown && a.w >= 34 && a.h >= 34), 'row actions visible and big enough with no hover');
    await shot(`24-${tag}-drawer`);
    await page.locator('#drawer .chat-item').first().locator('[data-act=rename]').tap();
    await page.fill('#drawer .rename', 'Phone chat');
    await page.press('#drawer .rename', 'Enter');
    await page.waitForSelector('#drawer .t:text("Phone chat")');
    await page.locator('#drawer .chat-item').first().locator('[data-act=pin]').tap();
    await page.waitForSelector('#drawer .group-label:text("Pinned")');
    await tap('#close-drawer');
    await page.waitForSelector('#drawer', { state: 'hidden' });
  });

  await step(`${label}: new-agent sheet fits and works by touch`, async () => {
    await tap('#new-agent-btn');
    await page.waitForSelector('.modal');
    await tap('[data-preset=planner]');
    eq(await page.inputValue('#f-name'), 'Planner');
    ok(await noOverflow(), 'no horizontal scroll with the sheet open');
    const box = await page.locator('.modal').boundingBox();
    ok(box.x >= 0 && box.x + box.width <= page.viewportSize().width + 0.5, 'sheet is within the screen width');
    await shot(`25-${tag}-new-agent`);
    await tap('#save-agent');
    await page.waitForSelector('.modal', { state: 'detached' });
    eq(await page.locator('#agent-chip .name').textContent(), 'Planner');
  });
  await ctx.close();
}

async function main() {
  const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'PhoneDocs-')));
  const brain = (body) => (body.messages.at(-1).role === 'tool' ? { text: 'Done.' } : { tools: [{ name: 'trash_files', args: { paths: [path.join(folder, body.messages.filter((m) => m.role === 'user').at(-1).content.replace('trash ', ''))] } }] });
  const up = await fakeUpstream(scriptedOpenAI([(b) => brain(b)]));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-mobile-'));
  const srv = await startServer({ dataDir, env: { MUSER_LAN: '1', MUSER_PORT: '0', OPENAI_BASE_URL: up.base, OPENAI_API_KEY: 'sk-fake' } });
  const lanUrl = srv.url.replace('127.0.0.1', lanIp); // what the phone opens: the computer's network address + key
  console.log(`  phone link: http://${lanIp}:${new URL(srv.url).port}/?key=<hidden>`);
  const browser = await chromium.launch();

  // A device WITHOUT the key must see nothing.
  const stranger = await browser.newContext({ ...devices['iPhone 13'], defaultBrowserType: undefined });
  const sp = await stranger.newPage();
  await step('a phone without the key is locked out of the page and the API', async () => {
    const root = await sp.goto(`http://${lanIp}:${new URL(srv.url).port}/`);
    eq(root.status(), 401);
    ok((await sp.textContent('body')).includes('locked'), 'friendly locked message');
    const api = await sp.evaluate(async () => (await fetch('/api/state')).status);
    eq(api, 401);
  });
  await stranger.close();

  await runDevice('iPhone 13', devices['iPhone 13'], browser, lanUrl, folder, dataDir);
  await runDevice('Pixel 7', devices['Pixel 7'], browser, lanUrl, folder, dataDir);

  await step('no console or page errors on either phone', async () => { ok(pageErrors.length === 0, pageErrors.join(' | ')); });
  await browser.close();
  await srv.stop();
  await up.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} phone checks passed. Screenshots: ${OUT}`);
  process.exit(failed.length ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
