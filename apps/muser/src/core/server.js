'use strict';
// Local API + static server for the Muser window. Binds to loopback only and requires a
// per-launch token on every /api call, so other local pages cannot drive it.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Store, HttpError, LIMITS } = require('./store');
const { resolveProvider, streamReply, NO_RESULT } = require('./providers');
const { createToolbox, appTrash } = require('./tools');

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
const MAX_STEPS = 8;

function publicSettings(store, env) {
  const s = store.settings;
  return {
    provider: s.provider,
    openaiModel: s.openaiModel,
    anthropicModel: s.anthropicModel,
    savedKey: { openai: !!s.keys.openai, anthropic: !!s.keys.anthropic },
    envKey: { openai: !!env.OPENAI_API_KEY, anthropic: !!env.ANTHROPIC_API_KEY },
    folders: s.folders,
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

function buildHistory(chat, current) {
  return chat.messages
    .filter((m) => m !== current && (m.role === 'user' || m.role === 'assistant') && (m.content || (m.toolCalls && m.toolCalls.length)) && !(m.status === 'error' && !(m.toolCalls && m.toolCalls.length)))
    .slice(-HISTORY_LIMIT)
    .map((m) =>
      m.role === 'user'
        ? { role: 'user', content: m.content }
        : { role: 'assistant', content: m.content, toolCalls: (m.toolCalls || []).map((c) => ({ id: c.id, name: c.name, args: c.args, result: c.result ?? NO_RESULT })) },
    );
}

function createApp({ dataDir, token = crypto.randomBytes(24).toString('hex'), env = process.env, trash }) {
  const store = new Store(dataDir);
  const trasher = trash || appTrash(dataDir);
  const active = new Map(); // chatId -> AbortController
  const waiting = new Map(); // chatId -> { callId, resolve } while an approval card is open
  let port = 0;

  function audit(entry) {
    try {
      fs.appendFileSync(path.join(dataDir, 'actions.log'), `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, { mode: 0o600 });
    } catch { /* the log must never break a reply */ }
  }

  const liveFolders = () => store.settings.folders.filter((f) => { try { return fs.statSync(f).isDirectory(); } catch { return false; } });

  // Resolves when the user answers the card for `callId`, or the turn is aborted.
  function waitForDecision(chatId, callId, signal) {
    return new Promise((resolve) => {
      const done = (v) => { waiting.delete(chatId); signal.removeEventListener('abort', onAbort); resolve(v); };
      const onAbort = () => done('abort');
      if (signal.aborted) return done('abort');
      waiting.set(chatId, { callId, resolve: done });
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  async function generate(chat, first, res) {
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
    let assistant = first;
    let lastSave = 0;
    const save = () => { chat.updatedAt = Date.now(); store.saveChat(chat); lastSave = Date.now(); };

    // Runs one tool call: validate -> (approval) -> execute. Never throws.
    async function executeCall(call, agent, toolbox) {
      const update = () => { save(); send({ t: 'tool', call }); };
      if (call.args && call.args.__invalid) { call.status = 'error'; call.error = call.args.__invalid; call.result = JSON.stringify({ error: call.error }); call.label = call.name; update(); return; }
      if (!toolbox || !toolbox.has(call.name)) { call.status = 'error'; call.error = `Unknown tool "${call.name}".`; call.result = JSON.stringify({ error: call.error }); call.label = call.name; update(); return; }
      let plan;
      try {
        plan = toolbox.plan(call.name, call.args);
      } catch (err) {
        // Invalid or out-of-bounds requests are refused without bothering the user.
        call.status = 'error'; call.error = err.message; call.label = call.name; call.result = JSON.stringify({ error: err.message }); update(); return;
      }
      Object.assign(call, { readOnly: plan.readOnly, title: plan.title, label: plan.label, summary: plan.summary, items: plan.items });
      if (!plan.readOnly && !(agent.alwaysAllow || []).includes(call.name)) {
        call.status = 'awaiting';
        update();
        const decision = await waitForDecision(chat.id, call.id, ac.signal);
        if (decision === 'abort') { call.status = 'cancelled'; call.result = NO_RESULT; update(); return; }
        if (decision === 'deny') {
          call.status = 'denied';
          call.outcome = 'You denied this';
          call.result = JSON.stringify({ error: 'The user denied this action. Do not retry it; ask what they would like instead.' });
          audit({ agent: agent.name, chat: chat.id, tool: call.name, decision: 'denied', items: (call.items || []).slice(0, 20) });
          update();
          return;
        }
        if (decision === 'always') {
          const fresh = store.getAgent(agent.id);
          if (fresh && !(fresh.alwaysAllow || []).includes(call.name)) store.updateAgent(agent.id, { alwaysAllow: [...(fresh.alwaysAllow || []), call.name] });
        }
        call.decision = decision;
      }
      call.status = 'running';
      update();
      try {
        const out = await toolbox.run(call.name, plan);
        call.status = 'done';
        call.outcome = out.outcome;
        call.result = out.result;
        if (!plan.readOnly) audit({ agent: agent.name, chat: chat.id, tool: call.name, decision: call.decision || 'always-allowed', outcome: out.outcome, items: (call.items || []).slice(0, 50) });
      } catch (err) {
        call.status = 'error';
        call.error = err.message;
        call.result = JSON.stringify({ error: err.message });
        if (!plan.readOnly) audit({ agent: agent.name, chat: chat.id, tool: call.name, decision: call.decision || 'always-allowed', error: err.message });
      }
      update();
    }

    try {
      const agent = store.getAgent(chat.agentId);
      if (!agent) throw new HttpError(404, 'This chat’s agent was deleted.');
      const folders = liveFolders();
      const toolbox = folders.length ? createToolbox({ folders, trash: trasher, agentName: agent.name }) : null;
      for (let step = 0; ; step++) {
        if (step >= MAX_STEPS) throw new HttpError(400, `Stopped after ${MAX_STEPS} steps in one turn. Press Retry to keep going.`);
        let wanted = null;
        const stream = streamReply({ settings: store.settings, agent, messages: buildHistory(chat, assistant), tools: toolbox ? toolbox.definitions() : [], folders: toolbox ? toolbox.roots : [], signal: ac.signal, env });
        for await (const ev of stream) {
          if (ac.signal.aborted) break;
          if (ev.text) {
            assistant.content += ev.text;
            send({ t: 'delta', text: ev.text });
            if (Date.now() - lastSave > 400) save();
          }
          if (ev.tools) wanted = ev.tools;
        }
        if (ac.signal.aborted) { assistant.status = 'stopped'; break; }
        if (!wanted || !wanted.length) {
          if (!assistant.content && !(assistant.toolCalls && assistant.toolCalls.length)) { assistant.status = 'error'; assistant.error = 'The model returned an empty reply.'; }
          else assistant.status = 'done';
          break;
        }
        assistant.toolCalls = wanted.map((c) => ({ id: c.id, name: c.name, args: c.args, status: 'pending' }));
        save();
        send({ t: 'tools', calls: assistant.toolCalls });
        for (const call of assistant.toolCalls) {
          if (ac.signal.aborted) { call.status = 'cancelled'; call.result = NO_RESULT; continue; }
          await executeCall(call, agent, toolbox);
        }
        if (ac.signal.aborted) {
          for (const c of assistant.toolCalls) if (c.status === 'pending' || c.status === 'awaiting') { c.status = 'cancelled'; c.result = NO_RESULT; }
          assistant.status = 'stopped';
          break;
        }
        assistant.status = 'done';
        assistant = store.addMessage(chat, 'assistant', '', 'streaming');
        save();
        send({ t: 'next', message: assistant });
      }
    } catch (err) {
      if (ac.signal.aborted) assistant.status = 'stopped';
      else {
        assistant.status = 'error';
        assistant.error = err instanceof HttpError ? err.message : `Could not reach the model: ${err.cause?.code || err.message}`;
      }
    } finally {
      active.delete(chat.id);
      waiting.delete(chat.id);
      for (const c of assistant.toolCalls || []) if (c.status === 'pending' || c.status === 'awaiting') { c.status = 'cancelled'; c.result = NO_RESULT; }
      save();
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
    res.write(`data: ${JSON.stringify({ t: 'start', userMessage: userMessage && userMessage.role === 'user' ? userMessage : null, assistantMessage: assistant, title: chat.title })}\n\n`);
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
    suggestedFolders: store.suggestedFolders(),
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

  route('POST', '/api/chats/:id/approve', async ({ body, params }) => {
    const w = waiting.get(params.id);
    if (!w || w.callId !== body.callId) throw new HttpError(409, 'That request is no longer waiting for an answer.');
    if (!['allow', 'always', 'deny'].includes(body.decision)) throw new HttpError(400, 'Decision must be allow, always or deny.');
    w.resolve(body.decision);
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
      // Retry replaces a plain-text reply. A reply that ran tools stays (its results are history);
      // Retry then continues after it.
      const last = chat.messages[chat.messages.length - 1];
      if (last && last.role === 'assistant' && !(last.toolCalls && last.toolCalls.length)) chat.messages.pop();
      const tail = chat.messages[chat.messages.length - 1];
      if (!tail) throw new HttpError(400, 'Nothing to retry.');
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
