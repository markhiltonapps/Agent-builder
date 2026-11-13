'use strict';
// Streaming model providers. Each yields text deltas and stops promptly when `signal` aborts.

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
    `Add an OpenAI or Anthropic key in Settings to get real answers.`;
  for (const piece of text.match(/\S+\s*/g) || []) {
    if (signal.aborted) return;
    yield piece;
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

async function* openaiStream({ cfg, system, messages, signal }) {
  const response = await fetch(`${cfg.baseUrl}/v1/chat/completions`, {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({ model: cfg.model, stream: true, messages: [{ role: 'system', content: system }, ...messages] }),
  });
  if (!response.ok) await failFromResponse(response, cfg.apiKey);
  for await (const line of sseLines(response, signal)) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (data === '[DONE]') return;
    let evt;
    try { evt = JSON.parse(data); } catch { continue; }
    if (evt.error) throw new HttpError(502, String(evt.error.message || 'The provider reported an error.').slice(0, 300));
    const text = evt.choices?.[0]?.delta?.content;
    if (text) yield text;
  }
}

// Anthropic needs strictly alternating roles that start with the user.
function normalizeForAnthropic(messages) {
  const out = [];
  for (const m of messages) {
    const prev = out[out.length - 1];
    if (prev && prev.role === m.role) prev.content += `\n\n${m.content}`;
    else out.push({ role: m.role, content: m.content });
  }
  while (out.length && out[0].role !== 'user') out.shift();
  return out;
}

async function* anthropicStream({ cfg, system, messages, signal }) {
  const response = await fetch(`${cfg.baseUrl}/v1/messages`, {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/json', 'x-api-key': cfg.apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: cfg.model, max_tokens: 4096, stream: true, system, messages: normalizeForAnthropic(messages) }),
  });
  if (!response.ok) await failFromResponse(response, cfg.apiKey);
  for await (const line of sseLines(response, signal)) {
    if (!line.startsWith('data:')) continue;
    let evt;
    try { evt = JSON.parse(line.slice(5).trim()); } catch { continue; }
    if (evt.type === 'error') throw new HttpError(502, String(evt.error?.message || 'The provider reported an error.').slice(0, 300));
    if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') yield evt.delta.text;
    if (evt.type === 'message_stop') return;
  }
}

function compileSystemPrompt(agent) {
  const parts = [`You are ${agent.name}${agent.role ? `, ${agent.role}` : ''}.`];
  if (agent.instructions) parts.push(agent.instructions);
  parts.push(`Today is ${new Date().toDateString()}.`);
  return parts.join('\n\n');
}

function streamReply({ settings, agent, messages, signal, env = process.env }) {
  const cfg = resolveProvider(settings, env);
  if (cfg.provider === 'demo') return demoStream({ agent, messages, signal });
  if (!cfg.apiKey) {
    throw new HttpError(400, `No ${cfg.provider === 'openai' ? 'OpenAI' : 'Anthropic'} API key. Add one in Settings.`);
  }
  const system = compileSystemPrompt(agent);
  const run = cfg.provider === 'openai' ? openaiStream : anthropicStream;
  return run({ cfg, system, messages, signal });
}

module.exports = { resolveProvider, streamReply, compileSystemPrompt, normalizeForAnthropic };
