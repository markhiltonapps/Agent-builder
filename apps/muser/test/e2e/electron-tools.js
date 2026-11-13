'use strict';
// Desktop-app proof: approval card -> Allow -> the file goes to the system Trash.
// MUSER_PACKAGED=/path/to/muser tests a built package instead of the source checkout.
const { _electron: electron } = require('playwright');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fakeUpstream, scriptedOpenAI } = require('../helpers');

const root = path.join(__dirname, '..', '..');
const ok = (v, m) => { if (!v) throw new Error(m); };

(async () => {
  const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ElectronDocs-')));
  const victim = path.join(folder, 'old-report.txt');
  fs.writeFileSync(victim, 'bye');
  fs.writeFileSync(path.join(folder, 'keep.txt'), 'stay');
  const up = await fakeUpstream(scriptedOpenAI([{ tools: [{ name: 'trash_files', args: { paths: [victim] } }] }, { text: 'Moved it to the Trash.' }]));
  const env = { ...process.env, OPENAI_BASE_URL: up.base, OPENAI_API_KEY: 'sk-fake' };
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'muser-etools-'));
  const launchOpts = process.env.MUSER_PACKAGED
    ? { executablePath: process.env.MUSER_PACKAGED, args: [`--user-data-dir=${userData}`, '--no-sandbox'], env }
    : { executablePath: require(path.join(root, 'node_modules', 'electron')), args: [root, `--user-data-dir=${userData}`, '--no-sandbox'], env };
  const app = await electron.launch(launchOpts);
  const win = await app.firstWindow();
  await win.waitForSelector('html[data-ready]');
  const status = await win.evaluate(async (f) => {
    const token = document.querySelector('meta[name=muser-token]').content;
    const r = await fetch('/api/settings', { method: 'PUT', headers: { 'x-muser-token': token, 'content-type': 'application/json' }, body: JSON.stringify({ folders: [f] }) });
    return r.status;
  }, folder);
  ok(status === 200, `sharing the folder failed (${status})`);
  await win.fill('#input', 'trash old-report.txt');
  await win.press('#input', 'Enter');
  await win.waitForSelector('.approval', { timeout: 15000 });
  ok(fs.existsSync(victim), 'file untouched while the card is open');
  await win.screenshot({ path: path.join(root, 'test', 'e2e', 'out', 'electron-card.png') });
  await win.click('.approval [data-decision=allow]');
  await win.waitForSelector('.msg.assistant.last [data-act=retry]', { timeout: 15000 });
  ok(!fs.existsSync(victim) && fs.existsSync(path.join(folder, 'keep.txt')), 'only the approved file left the folder');
  const trashInfo = path.join(os.homedir(), '.local', 'share', 'Trash', 'info', 'old-report.txt.trashinfo');
  const inTrash = process.platform !== 'linux' || fs.existsSync(trashInfo) || fs.readdirSync(path.join(os.homedir(), '.local', 'share', 'Trash', 'info')).some((n) => n.startsWith('old-report'));
  ok(inTrash, 'file is in the system Trash (recoverable)');
  ok(!fs.existsSync(path.join(userData, 'data', 'trash')), 'desktop app used the system Trash, not the fallback folder');
  ok(fs.readFileSync(path.join(userData, 'data', 'actions.log'), 'utf8').includes('trash_files'), 'audit log written');
  await app.close();
  await up.close();
  console.log(`electron tool-use ok (${process.env.MUSER_PACKAGED ? 'packaged binary' : 'source'}): card -> Allow -> system Trash, audit logged`);
})().catch((e) => { console.error('electron tool-use FAILED:', e.message); process.exit(1); });
