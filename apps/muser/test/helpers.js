'use strict';
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/core/server');

const opened = [];
async function closeAll() {
  await Promise.all(opened.splice(0).map((a) => a.close().catch(() => {})));
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'muser-test-'));
}

async function boot(opts = {}) {
  const dataDir = opts.dataDir || tmpDir();
  const app = createApp({ dataDir, env: opts.env || {} });
  opened.push(app);
  const { port, token, url } = await app.listen(0);
  const call = async (method, p, body) => {
    const res = await fetch(`${url.replace(/\/$/, '')}${p}`, {
      method,
      headers: { 'x-muser-token': token, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  // Open a streaming endpoint; returns an async iterator of events plus an abort handle.
  const stream = async (p, body) => {
    const ac = new AbortController();
    const res = await fetch(`${url.replace(/\/$/, '')}${p}`, {
      method: 'POST',
      signal: ac.signal,
      headers: { 'x-muser-token': token, 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    if (!res.ok) return { status: res.status, error: (await res.json()).error, events: [] };
    async function* events() {
      let buf = '';
      for await (const chunk of res.body) {
        buf += Buffer.from(chunk).toString('utf8');
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (block.startsWith('data: ')) yield JSON.parse(block.slice(6));
        }
      }
    }
    return { status: res.status, abort: () => ac.abort(), events: events() };
  };
  const collect = async (p, body) => {
    const s = await stream(p, body);
    const out = [];
    for await (const e of s.events) out.push(e);
    return { status: s.status, error: s.error, events: out, done: out.find((e) => e.t === 'done')?.message, text: out.filter((e) => e.t === 'delta').map((e) => e.text).join('') };
  };
  return { app, dataDir, url, port, token, call, stream, collect };
}

// A fake provider API that streams in the OpenAI or Anthropic wire format.
function fakeUpstream(handler) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      seen.push({ url: req.url, headers: req.headers, body });
      handler({ req, res, body, n: seen.length });
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({ seen, base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }) }),
    ),
  );
}

const openaiOk = (words) => ({ res }) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const w of words) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: w } }] })}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
};

module.exports = { closeAll, boot, tmpDir, fakeUpstream, openaiOk };
