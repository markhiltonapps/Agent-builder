'use strict';
// Streaming model providers. Each provider yields events:
//   { text }               a piece of reply text
//   { tools: [{id,name,args}] }   the model wants to call tools (always the last event)
// and stops promptly when `signal` aborts.
//
// History is passed in a neutral shape:
//   { role: 'user', content }
//   { role: 'assistant', content, toolCalls?: [{ id, name, args, result }] }

const { HttpError } = require('./store');

function resolveProvider(settings, env = process.env) {
  const keyFor = (p) => settings.keys[p] || (p === 'openai' ? env.OPENAI_API_KEY : env.ANTHROPIC_API_KEY) || '';
  const source = (p) => (settings.keys[p] ? 'settings' : (p === 'openai' ? env.OPENAI_API_KEY : env.ANTHROPIC_API_KEY) ? 'environment' : 'none');
  let provider = settings.provider;
  if (provider === 'auto') provider = keyFor('openai') ? 'openai' : keyFor('anthropic') ? 'anthropic' : 'demo';
  if (provider === 'demo') return { provider: 'demo', model: 'demo', apiKey: '', keySource: 'none' };
  const apiKey = keyFor(provider);
  const model = provider === 'openai' ? settings.openaiModel : settings.anthropicModel;
  const baseUrl = (provider === 'openai' ? env.OPENAI_BASE_URL || 'https://api.openai.com' : env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/+$/, '').replace(/\/v1$/, '');
  return { provider, model, apiKey, baseUrl, keySource: source(provider) };
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      signal.removeEventListener('abort', done);
      clearTimeout(t);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

// Deterministic, offline stand-in so the app is usable (and testable) with no API key.
async function* demoStream({ agent, messages, signal }) {
  const last = [...messages].reverse().find((m) => m.role === 'user');
  const delay = Number(process.env.MUSER_DEMO_DELAY_MS ?? 25);
  const instr = (agent.instructions || '').split('\n')[0].slice(0, 140);
  const text =
    `Demo mode: no API key is configured, so this reply is generated locally.\n\n` +
    `I'm ${agent.name}${agent.role ? `, ${agent.role.toLowerCase()}` : ''}. ` +
    (instr ? `My instructions begin: "${instr}". ` : 'I have no custom instructions yet. ') +
    `You said: "${(last ? last.content : '').slice(0, 200)}".\n\n` +
    `Add an OpenAI or Anthropic key in Settings to get real answers. Working with your files needs a real model.`;
  for (const piece of text.match(/\S+\s*/g) || []) {
    if (signal.aborted) return;
    yield { text: piece };
    await sleep(delay, signal);
  }
}

async function* sseLines(response, signal) {
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of response.body) {
    if (signal.aborted) return;
    buf += decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, '');
      buf = buf.slice(idx + 1);
      if (line) yield line;
    }
  }
  if (buf.trim()) yield buf.trim();
}

async function failFromResponse(response, apiKey) {
  let detail = '';
  try {
    const body = await response.json();
    detail = body?.error?.message || body?.message || '';
  } catch {
    /* body was not JSON */
  }
  detail = String(detail).split(apiKey || '\u0000').join('***').slice(0, 300);
  const hint = response.status === 401 ? 'The API key was rejected.' : response.status === 429 ? 'Rate limited or out of quota.' : `The provider returned ${response.status}.`;
  throw new HttpError(502, detail ? `${hint} ${detail}` : hint);
}

function parseArgs(raw) {
  if (!raw || !raw.trim()) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : { __invalid: 'Arguments must be a JSON object.' };
  } catch {
    return { __invalid: 'Arguments were not valid JSON.' };
  }
}

const NO_RESULT = JSON.stringify({ error: 'This action was cancelled before it ran.' });

// ---- OpenAI ---------------------------------------------------------------------------------
function toOpenAiMessages(system, messages) {
  const out = [{ role: 'system', content: system }];
  for (const m of messages) {
    if (m.role === 'user') out.push({ role: 'user', content: m.content });
    else if (m.toolCalls && m.toolCalls.length) {
      out.push({
        role: 'assistant',
        content: m.content || null,
        tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args || {}) } })),
      });
      for (const c of m.toolCalls) out.push({ role: 'tool', tool_call_id: c.id, content: c.result ?? NO_RESULT });
    } else out.push({ role: 'assistant', content: m.content });
  }
  return out;
}

async function* openaiStream({ cfg, system, messages, tools, signal }) {
  const body = { model: cfg.model, stream: true, messages: toOpenAiMessages(system, messages) };
  if (tools && tools.length) body.tools = tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
  const response = await fetch(`${cfg.baseUrl}/v1/chat/completions`, {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify(body),
  });
  if (!response.ok) await failFromResponse(response, cfg.apiKey);
  const calls = [];
  const flush = function* () {
    if (calls.length) yield { tools: calls.filter(Boolean).map((c) => ({ id: c.id, name: c.name, args: parseArgs(c.args) })) };
  };
  for await (const line of sseLines(response, signal)) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (data === '[DONE]') break;
    let evt;
    try { evt = JSON.parse(data); } catch { continue; }
    if (evt.error) throw new HttpError(502, String(evt.error.message || 'The provider reported an error.').slice(0, 300));
    const delta = evt.choices?.[0]?.delta;
    if (delta?.content) yield { text: delta.content };
    for (const tc of delta?.tool_calls || []) {
      const slot = (calls[tc.index ?? 0] ||= { id: '', name: '', args: '' });
      if (tc.id) slot.id = tc.id;
      if (tc.function?.name) slot.name += tc.function.name;
      if (tc.function?.arguments) slot.args += tc.function.arguments;
    }
  }
  yield* flush();
}

// ---- Anthropic ------------------------------------------------------------------------------
const asBlocks = (content) => (typeof content === 'string' ? (content ? [{ type: 'text', text: content }] : []) : content);

function toAnthropicMessages(messages) {
  const out = [];
  const push = (role, content) => {
    const blocks = asBlocks(content);
    if (!blocks.length) return;
    const prev = out[out.length - 1];
    if (prev && prev.role === role) prev.content.push(...blocks);
    else out.push({ role, content: [...blocks] });
  };
  for (const m of messages) {
    if (m.role === 'user') push('user', m.content);
    else if (m.toolCalls && m.toolCalls.length) {
      push('assistant', [...asBlocks(m.content), ...m.toolCalls.map((c) => ({ type: 'tool_use', id: c.id, name: c.name, input: c.args || {} }))]);
      push('user', m.toolCalls.map((c) => ({ type: 'tool_result', tool_use_id: c.id, content: c.result ?? NO_RESULT })));
    } else push('assistant', m.content);
  }
  while (out.length && out[0].role !== 'user') out.shift();
  return out;
}

async function* anthropicStream({ cfg, system, messages, tools, signal }) {
  const body = { model: cfg.model, max_tokens: 4096, stream: true, system, messages: toAnthropicMessages(messages) };
  if (tools && tools.length) body.tools = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
  const response = await fetch(`${cfg.baseUrl}/v1/messages`, {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/json', 'x-api-key': cfg.apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(body),
  });
  if (!response.ok) await failFromResponse(response, cfg.apiKey);
  const blocks = new Map(); // index -> { id, name, json }
  const calls = [];
  for await (const line of sseLines(response, signal)) {
    if (!line.startsWith('data:')) continue;
    let evt;
    try { evt = JSON.parse(line.slice(5).trim()); } catch { continue; }
    if (evt.type === 'error') throw new HttpError(502, String(evt.error?.message || 'The provider reported an error.').slice(0, 300));
    if (evt.type === 'content_block_start' && evt.content_block?.type === 'tool_use') blocks.set(evt.index, { id: evt.content_block.id, name: evt.content_block.name, json: '' });
    else if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') yield { text: evt.delta.text };
    else if (evt.type === 'content_block_delta' && evt.delta?.type === 'input_json_delta' && blocks.has(evt.index)) blocks.get(evt.index).json += evt.delta.partial_json || '';
    else if (evt.type === 'content_block_stop' && blocks.has(evt.index)) {
      const b = blocks.get(evt.index);
      calls.push({ id: b.id, name: b.name, args: parseArgs(b.json) });
      blocks.delete(evt.index);
    } else if (evt.type === 'message_stop') break;
  }
  if (calls.length) yield { tools: calls };
}

function compileSystemPrompt(agent, { folders = [], toolNames = [] } = {}) {
  const parts = [`You are ${agent.name}${agent.role ? `, ${agent.role}` : ''}.`];
  if (agent.instructions) parts.push(agent.instructions);
  if (toolNames.length) {
    parts.push(
      `You can work with files on the user's computer, but only inside these shared folders (use absolute paths):\n${folders.map((f) => `- ${f}`).join('\n')}\n` +
        'Looking at files runs immediately. Anything that changes files (moving, creating, trashing) is shown to the user, who can allow or deny it. ' +
        'Look before you act, keep changes small and specific, and never say something was done unless the tool result says it was. ' +
        'If the user denies an action, do not retry it; ask what they would like instead.',
    );
  } else {
    parts.push('You cannot access the user\'s files. If they ask you to work with files, tell them to share a folder in Settings.');
  }
  parts.push(`Today is ${new Date().toDateString()}.`);
  return parts.join('\n\n');
}

function streamReply({ settings, agent, messages, tools = [], folders = [], signal, env = process.env }) {
  const cfg = resolveProvider(settings, env);
  if (cfg.provider === 'demo') return demoStream({ agent, messages, signal });
  if (!cfg.apiKey) {
    throw new HttpError(400, `No ${cfg.provider === 'openai' ? 'OpenAI' : 'Anthropic'} API key. Add one in Settings.`);
  }
  const system = compileSystemPrompt(agent, { folders, toolNames: tools.map((t) => t.name) });
  const run = cfg.provider === 'openai' ? openaiStream : anthropicStream;
  return run({ cfg, system, messages, tools, signal });
}

module.exports = { resolveProvider, streamReply, compileSystemPrompt, toAnthropicMessages, toOpenAiMessages, NO_RESULT };
