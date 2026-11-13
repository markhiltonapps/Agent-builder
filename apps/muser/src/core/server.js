'use strict';
// Local API + static server for the Muser window. Binds to loopback only and requires a
// per-launch token on every /api call, so other local pages cannot drive it.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Store, HttpError, LIMITS } = require('./store');
const { resolveProvider, streamReply } = require('./providers');

const RENDERER_DIR = path.join(__dirname, '..', 'renderer');
const STATIC = {
  '/app.css': 'text/css; charset=utf-8',
  '/app.js': 'text/javascript; charset=utf-8',
  '/markdown.js': 'text/javascript; charset=utf-8',
  '/icon.png': 'image/png',
};
const CSP =
  "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const MAX_BODY = 1024 * 1024;
const HISTORY_LIMIT = 40;

function publicSettings(store, env) {
  const s = store.settings;
  return {
    provider: s.provider,
    openaiModel: s.openaiModel,
    anthropicModel: s.anthropicModel,
    savedKey: { openai: !!s.keys.openai, anthropic: !!s.keys.anthropic },
    envKey: { openai: !!env.OPENAI_API_KEY, anthropic: !!env.ANTHROPIC_API_KEY },
  };
}

function activeProvider(store, env) {
  const { provider, model, keySource } = resolveProvider(store.settings, env);
  return { provider, model, keySource };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, 'Request too large.'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error();
        resolve(v);
      } catch {
        reject(new HttpError(400, 'Body must be a JSON object.'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, body) {
  const data = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(data);
}

function buildHistory(chat, assistant) {
  return chat.messages
    .filter((m) => m !== assistant && (m.role === 'user' || m.role === 'assistant') && m.content && m.status !== 'error')
    .slice(-HISTORY_LIMIT)
    .map((m) => ({ role: m.role, content: m.content }));
}

function createApp({ dataDir, token = crypto.randomBytes(24).toString('hex'), env = process.env }) {
  const store = new Store(dataDir);
  const active = new Map(); // chatId -> AbortController
  let port = 0;

  async function generate(chat, assistant, res) {
    const ac = new AbortController();
    active.set(chat.id, ac);
    let clientGone = false;
    res.on('close', () => {
      if (!res.writableEnded) {
        clientGone = true;
        ac.abort(); // the client hung up: treat it as Stop
      }
    });
    const send = (obj) => {
      if (!clientGone && !res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`);
    };
    let lastSave = 0;
    try {
      const agent = store.getAgent(chat.agentId);
      if (!agent) throw new HttpError(404, 'This chat’s agent was deleted.');
      const stream = streamReply({ settings: store.settings, agent, messages: buildHistory(chat, assistant), signal: ac.signal, env });
      for await (const piece of stream) {
        if (ac.signal.aborted) break;
        assistant.content += piece;
        send({ t: 'delta', text: piece });
        const now = Date.now();
        if (now - lastSave > 400) {
          chat.updatedAt = now;
          store.saveChat(chat);
          lastSave = now;
        }
      }
      if (ac.signal.aborted) assistant.status = 'stopped';
      else if (!assistant.content) {
        assistant.status = 'error';
        assistant.error = 'The model returned an empty reply.';
      } else assistant.status = 'done';
    } catch (err) {
      if (ac.signal.aborted) assistant.status = 'stopped';
      else {
        assistant.status = 'error';
        assistant.error = err instanceof HttpError ? err.message : `Could not reach the model: ${err.cause?.code || err.message}`;
      }
    } finally {
      active.delete(chat.id);
      chat.updatedAt = Date.now();
      store.saveChat(chat);
      send({ t: 'done', message: assistant });
      if (!res.writableEnded) res.end();
    }
  }

  function startStream(res, chat, userMessage, assistant) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write(`data: ${JSON.stringify({ t: 'start', userMessage, assistantMessage: assistant, title: chat.title })}\n\n`);
    return generate(chat, assistant, res);
  }

  const routes = [];
  const route = (method, pattern, handler) => routes.push({ method, re: new RegExp(`^${pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)')}$`), handler });

  route('GET', '/api/state', async () => ({
    agents: store.listAgents(),
    chats: store.listChats(),
    settings: publicSettings(store, env),
    active: activeProvider(store, env),
    busy: [...active.keys()],
    limits: LIMITS,
  }));
  route('PUT', '/api/settings', async ({ body }) => {
    store.saveSettings(body);
    return { settings: publicSettings(store, env), active: activeProvider(store, env) };
  });
  route('POST', '/api/agents', async ({ body }) => ({ agent: store.createAgent(body) }));
  route('PATCH', '/api/agents/:id', async ({ body, params }) => ({ agent: store.updateAgent(params.id, body) }));
  route('DELETE', '/api/agents/:id', async ({ params }) => {
    for (const chat of store.chats.values()) if (chat.agentId === params.id) active.get(chat.id)?.abort();
    store.deleteAgent(params.id);
    return null;
  });
  route('POST', '/api/chats', async ({ body }) => ({ chat: store.createChat(body.agentId) }));
  route('GET', '/api/chats/:id', async ({ params }) => {
    const chat = store.getChat(params.id);
    if (!chat) throw new HttpError(404, 'Chat not found.');
    return { chat, busy: active.has(chat.id) };
  });
  route('PATCH', '/api/chats/:id', async ({ body, params }) => {
    const chat = store.updateChat(params.id, body);
    return { chat: store.summary(chat) };
  });
  route('DELETE', '/api/chats/:id', async ({ params }) => {
    active.get(params.id)?.abort();
    store.deleteChat(params.id);
    return null;
  });
  route('POST', '/api/chats/:id/stop', async ({ params }) => {
    active.get(params.id)?.abort();
    return null;
  });

  // Streaming routes write their own response.
  const streaming = {
    send: async ({ body, params, res }) => {
      const chat = store.getChat(params.id);
      if (!chat) throw new HttpError(404, 'Chat not found.');
      if (active.has(chat.id)) throw new HttpError(409, 'This chat is already replying.');
      if (typeof body.text !== 'string' || !body.text.trim()) throw new HttpError(400, 'Message is required.');
      if (body.text.length > LIMITS.message) throw new HttpError(400, `Message is too long (max ${LIMITS.message} characters).`);
      const userMessage = store.addMessage(chat, 'user', body.text.trim());
      const assistant = store.addMessage(chat, 'assistant', '', 'streaming');
      store.saveChat(chat); // the user's message is durable before any model call
      await startStream(res, chat, userMessage, assistant);
    },
    retry: async ({ params, res }) => {
      const chat = store.getChat(params.id);
      if (!chat) throw new HttpError(404, 'Chat not found.');
      if (active.has(chat.id)) throw new HttpError(409, 'This chat is already replying.');
      const last = chat.messages[chat.messages.length - 1];
      if (last && last.role === 'assistant') chat.messages.pop();
      const tail = chat.messages[chat.messages.length - 1];
      if (!tail || tail.role !== 'user') throw new HttpError(400, 'Nothing to retry.');
      const assistant = store.addMessage(chat, 'assistant', '', 'streaming');
      store.saveChat(chat);
      await startStream(res, chat, tail, assistant);
    },
  };

  const indexHtml = () =>
    fs.readFileSync(path.join(RENDERER_DIR, 'index.html'), 'utf8').replace('__MUSER_TOKEN__', token);

  const tokenBuf = Buffer.from(token);
  const tokenOk = (given) => {
    const g = Buffer.from(String(given || ''));
    return g.length === tokenBuf.length && crypto.timingSafeEqual(g, tokenBuf);
  };

  const server = http.createServer(async (req, res) => {
    try {
      const host = String(req.headers.host || '');
      if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) throw new HttpError(403, 'Forbidden host.');
      const url = new URL(req.url, 'http://x');
      const pathname = url.pathname;
      const secure = { 'content-security-policy': CSP, 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'cross-origin-resource-policy': 'same-origin' };

      if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...secure });
        return res.end(indexHtml());
      }
      if (req.method === 'GET' && STATIC[pathname]) {
        const file = path.join(RENDERER_DIR, pathname.slice(1));
        res.writeHead(200, { 'content-type': STATIC[pathname], 'cache-control': 'no-store', ...secure });
        return res.end(fs.readFileSync(file));
      }
      if (!pathname.startsWith('/api/')) throw new HttpError(404, 'Not found.');
      if (!tokenOk(req.headers['x-muser-token'])) throw new HttpError(401, 'Missing or wrong token.');

      const body = req.method === 'GET' || req.method === 'DELETE' ? {} : await readBody(req);
      if (req.method === 'POST') {
        const m = /^\/api\/chats\/([^/]+)\/(send|retry)$/.exec(pathname);
        if (m) return await streaming[m[2]]({ body, params: { id: m[1] }, res });
      }
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const match = r.re.exec(pathname);
        if (!match) continue;
        const out = await r.handler({ body, params: match.groups || {}, req });
        return out === null ? (res.writeHead(204), res.end()) : sendJson(res, 200, out);
      }
      throw new HttpError(404, 'Not found.');
    } catch (err) {
      if (res.headersSent) return res.end();
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) console.error(err);
      sendJson(res, status, { error: status === 500 ? 'Internal error.' : err.message });
    }
  });

  return {
    store,
    token,
    async listen(wantedPort = 0) {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(wantedPort, '127.0.0.1', resolve);
      });
      port = server.address().port;
      return { port, token, url: `http://127.0.0.1:${port}/` };
    },
    async close() {
      for (const ac of active.values()) ac.abort();
      // Give in-flight generations a moment to persist their "stopped" state.
      for (let i = 0; i < 50 && active.size; i++) await new Promise((r) => setTimeout(r, 20));
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

module.exports = { createApp };
