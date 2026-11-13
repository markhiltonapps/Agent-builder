'use strict';
// Starts the Muser server as a real child process so tests can kill -9 and restart it.
const { spawn } = require('node:child_process');
const path = require('node:path');

const CLI = path.join(__dirname, '..', '..', 'src', 'core', 'cli.js');

function startServer({ dataDir, env = {} }) {
  const clean = { ...process.env };
  delete clean.OPENAI_API_KEY; delete clean.ANTHROPIC_API_KEY;
  const child = spawn(process.execPath, [CLI], { env: { ...clean, MUSER_DATA_DIR: dataDir, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (d) => (stderr += d));
  return new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error(`server did not start: ${stderr}`)), 10000);
    child.stdout.on('data', (d) => {
      out += d;
      const m = /MUSER_READY (\S+)/.exec(out);
      if (m) { clearTimeout(timer); resolve({ url: m[1], child, kill9: () => new Promise((r) => { child.once('exit', r); child.kill('SIGKILL'); }), stop: () => new Promise((r) => { child.once('exit', r); child.kill('SIGTERM'); }) }); }
    });
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`server exited ${code}: ${stderr}`)); });
  });
}
module.exports = { startServer };
