'use strict';
// Persistent storage for agents, chats and settings. Plain JSON files, written atomically
// (temp file + fsync + rename) so a crash or kill -9 can never leave a half-written chat.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const { MUTATING_TOOLS } = require('./tools');

const LIMITS = { name: 40, role: 120, instructions: 8000, emoji: 8, title: 120, message: 20000 };

const DEFAULT_SETTINGS = {
  provider: 'auto', // auto | openai | anthropic | demo
  openaiModel: 'gpt-4o-mini',
  anthropicModel: 'claude-sonnet-5-5',
  keys: { openai: '', anthropic: '' },
  folders: [], // folders agents may read and (with approval) change
};
const MAX_FOLDERS = 8;

const PALETTE = ['#cfe3ff', '#ffe2c7', '#d9f0d2', '#f3d4ee', '#fff0b8', '#d4ecf0'];

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const uid = (prefix) => `${prefix}_${crypto.randomBytes(8).toString('hex')}`;

function writeAtomic(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    fs.writeSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

function readJson(file, fallback) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
  try {
    return JSON.parse(raw);
  } catch {
    // Never discard user data: park the unreadable file and carry on with the fallback.
    fs.renameSync(file, `${file}.corrupt-${Date.now()}`);
    return fallback;
  }
}

function cleanText(value, max, label, { required = false } = {}) {
  if (value === undefined || value === null) value = '';
  if (typeof value !== 'string') throw new HttpError(400, `${label} must be text.`);
  const text = value.replace(/\r\n/g, '\n').trim();
  if (required && !text) throw new HttpError(400, `${label} is required.`);
  if (text.length > max) {
    throw new HttpError(
      400,
      label === 'Instructions'
        ? 'These instructions are too long to save.'
        : `${label} is too long (max ${max} characters).`,
    );
  }
  return text;
}

class Store {
  constructor(dir) {
    this.dir = dir;
    this.chatDir = path.join(dir, 'chats');
    fs.mkdirSync(this.chatDir, { recursive: true, mode: 0o700 });

    this.agents = readJson(path.join(dir, 'agents.json'), null);
    if (!Array.isArray(this.agents) || this.agents.length === 0) {
      this.agents = [this._seedAgent()];
      this._saveAgents();
    }
    this.settings = { ...DEFAULT_SETTINGS, ...readJson(path.join(dir, 'settings.json'), {}) };
    this.settings.keys = { ...DEFAULT_SETTINGS.keys, ...(this.settings.keys || {}) };

    this.chats = new Map();
    this.recovered = 0;
    for (const file of fs.readdirSync(this.chatDir)) {
      if (!file.endsWith('.json')) continue;
      const chat = readJson(path.join(this.chatDir, file), null);
      if (!chat || !chat.id || !Array.isArray(chat.messages)) continue;
      // A reply that was still streaming when the process died is marked, not lost.
      let touched = false;
      for (const m of chat.messages) {
        if (m.status === 'streaming') {
          m.status = 'interrupted';
          touched = true;
          this.recovered++;
        }
        for (const c of m.toolCalls || []) {
          // A request that was waiting for approval never ran. One that was running may or may not have finished.
          if (c.status === 'pending' || c.status === 'awaiting') {
            c.status = 'cancelled';
            c.result = JSON.stringify({ error: 'This action was cancelled before it ran.' });
            touched = true;
          } else if (c.status === 'running') {
            c.status = 'interrupted';
            c.outcome = 'Interrupted. It may or may not have finished';
            c.result = JSON.stringify({ error: 'The app was closed while this ran; check whether it completed.' });
            touched = true;
          }
        }
      }
      this.chats.set(chat.id, chat);
      if (touched) this.saveChat(chat);
    }
  }

  _seedAgent() {
    const now = Date.now();
    return {
      id: uid('agent'),
      name: 'Muser',
      role: 'Your everyday assistant',
      emoji: '🪶',
      color: PALETTE[0],
      instructions:
        'Be warm, direct and concise. Lead with the answer. Ask a clarifying question only when the request is genuinely ambiguous.',
      createdAt: now,
      updatedAt: now,
    };
  }

  _saveAgents() {
    writeAtomic(path.join(this.dir, 'agents.json'), JSON.stringify(this.agents, null, 2));
  }

  // ---- settings -------------------------------------------------------------------------
  saveSettings(patch) {
    const next = { ...this.settings, keys: { ...this.settings.keys } };
    if (patch.provider !== undefined) {
      if (!['auto', 'openai', 'anthropic', 'demo'].includes(patch.provider)) {
        throw new HttpError(400, 'Unknown provider.');
      }
      next.provider = patch.provider;
    }
    for (const field of ['openaiModel', 'anthropicModel']) {
      if (patch[field] !== undefined) next[field] = cleanText(patch[field], 80, 'Model', { required: true });
    }
    if (patch.folders !== undefined) next.folders = this._validateFolders(patch.folders);
    if (patch.keys) {
      for (const k of ['openai', 'anthropic']) {
        if (patch.keys[k] !== undefined) next.keys[k] = cleanText(patch.keys[k], 400, 'API key');
      }
    }
    this.settings = next;
    writeAtomic(path.join(this.dir, 'settings.json'), JSON.stringify(next, null, 2));
  }

  _validateFolders(list) {
    if (!Array.isArray(list)) throw new HttpError(400, 'Folders must be a list.');
    if (list.length > MAX_FOLDERS) throw new HttpError(400, `You can share up to ${MAX_FOLDERS} folders.`);
    const home = fs.realpathSync.native(os.homedir());
    const data = fs.realpathSync.native(this.dir);
    const out = [];
    for (const raw of list) {
      if (typeof raw !== 'string' || !raw.trim()) throw new HttpError(400, 'Folder path is required.');
      let p = raw.trim();
      if (p === '~' || p.startsWith('~/')) p = path.join(os.homedir(), p.slice(1));
      if (!path.isAbsolute(p)) throw new HttpError(400, `"${raw}" is not an absolute path.`);
      let real;
      try {
        real = fs.realpathSync.native(path.resolve(p));
        if (!fs.statSync(real).isDirectory()) throw new Error('not a directory');
      } catch {
        throw new HttpError(400, `"${raw}" is not a folder that exists.`);
      }
      if (real === path.parse(real).root) throw new HttpError(400, 'Sharing a whole drive is not allowed. Pick a specific folder.');
      if (real === home) throw new HttpError(400, 'Sharing your whole home folder is not allowed. Pick a folder inside it, like Downloads.');
      if (real === data || real.startsWith(data + path.sep) || data.startsWith(real + path.sep)) throw new HttpError(400, 'That folder overlaps Muser\'s own data.');
      if (!out.includes(real)) out.push(real);
    }
    return out;
  }

  suggestedFolders() {
    const out = [];
    for (const name of ['Downloads', 'Documents', 'Desktop']) {
      const p = path.join(os.homedir(), name);
      try {
        const real = fs.realpathSync.native(p);
        if (fs.statSync(real).isDirectory() && !this.settings.folders.includes(real)) out.push({ name, path: real });
      } catch { /* not present */ }
    }
    return out;
  }

  // ---- agents ---------------------------------------------------------------------------
  listAgents() {
    return this.agents;
  }

  getAgent(id) {
    return this.agents.find((a) => a.id === id) || null;
  }

  _agentFields(input, base = {}) {
    const out = { ...base };
    if ('name' in input) out.name = cleanText(input.name, LIMITS.name, 'Name', { required: true });
    if ('role' in input) out.role = cleanText(input.role, LIMITS.role, 'Role');
    if ('emoji' in input) out.emoji = cleanText(input.emoji, LIMITS.emoji, 'Avatar') || '🙂';
    if ('instructions' in input) out.instructions = cleanText(input.instructions, LIMITS.instructions, 'Instructions');
    if ('color' in input) out.color = PALETTE.includes(input.color) ? input.color : PALETTE[0];
    if ('alwaysAllow' in input) {
      if (!Array.isArray(input.alwaysAllow) || input.alwaysAllow.some((n) => !MUTATING_TOOLS.includes(n))) throw new HttpError(400, 'Unknown action in the always-allowed list.');
      out.alwaysAllow = [...new Set(input.alwaysAllow)];
    }
    return out;
  }

  createAgent(input) {
    const now = Date.now();
    const agent = this._agentFields(
      { name: input.name, role: input.role ?? '', emoji: input.emoji ?? '🙂', instructions: input.instructions ?? '', color: input.color, alwaysAllow: [] },
      { id: uid('agent'), createdAt: now, updatedAt: now },
    );
    this.agents.push(agent);
    this._saveAgents();
    return agent;
  }

  updateAgent(id, patch) {
    const agent = this.getAgent(id);
    if (!agent) throw new HttpError(404, 'Agent not found.');
    Object.assign(agent, this._agentFields(patch, agent), { updatedAt: Date.now() });
    this._saveAgents();
    return agent;
  }

  deleteAgent(id) {
    if (!this.getAgent(id)) throw new HttpError(404, 'Agent not found.');
    if (this.agents.length === 1) throw new HttpError(400, 'You need at least one agent.');
    this.agents = this.agents.filter((a) => a.id !== id);
    this._saveAgents();
    for (const chat of [...this.chats.values()]) if (chat.agentId === id) this.deleteChat(chat.id);
  }

  // ---- chats ----------------------------------------------------------------------------
  saveChat(chat) {
    writeAtomic(path.join(this.chatDir, `${chat.id}.json`), JSON.stringify(chat));
  }

  summary(chat) {
    const last = [...chat.messages].reverse().find((m) => m.content);
    return {
      id: chat.id,
      agentId: chat.agentId,
      title: chat.title,
      pinned: !!chat.pinned,
      createdAt: chat.createdAt,
      updatedAt: chat.updatedAt,
      messageCount: chat.messages.length,
      preview: last ? last.content.replace(/\s+/g, ' ').slice(0, 90) : '',
    };
  }

  listChats() {
    return [...this.chats.values()].map((c) => this.summary(c)).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  getChat(id) {
    return this.chats.get(id) || null;
  }

  createChat(agentId) {
    if (!this.getAgent(agentId)) throw new HttpError(404, 'Agent not found.');
    const now = Date.now();
    const chat = { id: uid('chat'), agentId, title: 'New chat', titleEdited: false, pinned: false, createdAt: now, updatedAt: now, messages: [] };
    this.chats.set(chat.id, chat);
    this.saveChat(chat);
    return chat;
  }

  updateChat(id, patch) {
    const chat = this.getChat(id);
    if (!chat) throw new HttpError(404, 'Chat not found.');
    if (patch.title !== undefined) {
      chat.title = cleanText(patch.title, LIMITS.title, 'Title', { required: true });
      chat.titleEdited = true;
    }
    if (patch.pinned !== undefined) chat.pinned = !!patch.pinned;
    this.saveChat(chat);
    return chat;
  }

  deleteChat(id) {
    if (!this.chats.delete(id)) throw new HttpError(404, 'Chat not found.');
    try {
      fs.unlinkSync(path.join(this.chatDir, `${id}.json`));
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }

  addMessage(chat, role, content, status = 'done') {
    const message = { id: uid('msg'), role, content, status, createdAt: Date.now() };
    chat.messages.push(message);
    chat.updatedAt = message.createdAt;
    if (role === 'user' && !chat.titleEdited && chat.messages.filter((m) => m.role === 'user').length === 1) {
      chat.title = content.replace(/\s+/g, ' ').slice(0, 48) || 'New chat';
    }
    return message;
  }
}

module.exports = { Store, HttpError, LIMITS, PALETTE, DEFAULT_SETTINGS, uid };
