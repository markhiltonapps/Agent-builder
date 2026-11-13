'use strict';
// Launches the real Electron app, sends a message, quits, relaunches and checks the chat is still there.
const { _electron: electron } = require('playwright');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-electron-'));
const env = { ...process.env, MUSER_DEMO_DELAY_MS: '10' };
delete env.OPENAI_API_KEY; delete env.ANTHROPIC_API_KEY;

async function launch() {
  // MUSER_PACKAGED=/path/to/muser tests a built package instead of the source checkout.
  if (process.env.MUSER_PACKAGED) return electron.launch({ executablePath: process.env.MUSER_PACKAGED, args: [`--user-data-dir=${userData}`, '--no-sandbox'], env });
  return electron.launch({ executablePath: require(path.join(root, 'node_modules', 'electron')), args: [root, `--user-data-dir=${userData}`, '--no-sandbox'], env });
}
const ok = (v, m) => { if (!v) throw new Error(m); };

(async () => {
  let app = await launch();
  let win = await app.firstWindow();
  await win.waitForSelector('html[data-ready]');
  ok((await win.title()) === 'Muser', 'window title is Muser');
  await win.fill('#input', 'Hello from the desktop app');
  await win.press('#input', 'Enter');
  await win.waitForSelector('.msg.assistant.last [data-act=retry]', { timeout: 15000 });
  const reply = await win.locator('.msg.assistant .bubble').last().textContent();
  ok(reply.includes('Hello from the desktop app'), 'reply streamed in the desktop window');
  await win.screenshot({ path: path.join(root, 'test', 'e2e', 'out', 'electron-1.png') });
  await app.close(); // graceful quit

  const t0 = Date.now();
  app = await launch();
  win = await app.firstWindow();
  await win.waitForSelector('html[data-ready]');
  const ms = Date.now() - t0;
  ok((await win.locator('.msg.user').first().textContent()).includes('Hello from the desktop app'), 'chat restored after relaunch');
  ok((await win.locator('.msg.assistant .bubble').last().textContent()) === reply, 'reply text identical after relaunch');
  await win.screenshot({ path: path.join(root, 'test', 'e2e', 'out', 'electron-2.png') });
  await app.close();
  console.log(`electron smoke ok: streamed reply, saved chat restored after relaunch (relaunch to ready ${ms}ms)`);
})().catch((e) => { console.error('electron smoke FAILED:', e.message); process.exit(1); });
