'use strict';
(function () {
  const TOKEN = document.querySelector('meta[name="muser-token"]').content;
  const md = window.MuserMarkdown;
  if (/Mac/.test(navigator.platform || navigator.userAgent)) document.body.classList.add('mac');

  // ---------------------------------------------------------------- tiny helpers
  const $ = (sel, root = document) => root.querySelector(sel);
  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style') Object.assign(el.style, v);
      else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'value' || k === 'checked' || k === 'disabled') el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    const add = (kid) => {
      if (Array.isArray(kid)) kid.forEach(add);
      else if (kid !== null && kid !== undefined && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    };
    kids.forEach(add);
    return el;
  }

  const ICONS = {
    chat: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20.5l1.4-4.6A8 8 0 1 1 21 12z"/>',
    menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
    compose: '<path d="M12 5H6a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-6"/><path d="M18.5 3.5a2.1 2.1 0 0 1 3 3L12 16l-4 1 1-4z"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    send: '<path d="M12 19V5M5 12l7-7 7 7"/>',
    stop: '<rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" stroke="none"/>',
    pin: '<path d="M9 4h6l-1 6 3 3v2H7v-2l3-3-1-6zM12 15v5"/>',
    edit: '<path d="M4 20h4L19 9l-4-4L4 16v4zM13 7l4 4"/>',
    trash: '<path d="M5 7h14M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
    copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
    retry: '<path d="M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6"/>',
    settings: '<path d="M5 9h14M5 15h14"/>',
    search: '<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5"/>',
    check: '<path d="M5 12l5 5 9-10"/>',
    x: '<path d="M6 6l12 12M18 6L6 18"/>',
    monitor: '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4"/>',
    chevron: '<path d="M6 9l6 6 6-6"/>',
    folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  };
  function icon(name, size = 22) {
    const span = document.createElement('span');
    span.style.display = 'inline-flex';
    span.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
    return span;
  }

  function avatar(agent, size) {
    return h('span', { class: 'avatar', style: { background: agent.color, width: size ? `${size}px` : '', height: size ? `${size}px` : '' } }, agent.emoji);
  }

  const timeFmt = new Intl.DateTimeFormat([], { hour: 'numeric', minute: '2-digit' });
  const dateFmt = new Intl.DateTimeFormat([], { weekday: 'short', month: 'short', day: 'numeric' });
  const day0 = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const dayDiff = (ts) => Math.round((day0(new Date()) - day0(new Date(ts))) / 864e5);
  function stamp(ts) {
    const d = dayDiff(ts);
    if (d === 0) return timeFmt.format(ts);
    if (d === 1) return `Yesterday ${timeFmt.format(ts)}`;
    return `${dateFmt.format(ts)}, ${timeFmt.format(ts)}`;
  }
  const groupOf = (c) => (c.pinned ? 'Pinned' : dayDiff(c.updatedAt) === 0 ? 'Today' : dayDiff(c.updatedAt) === 1 ? 'Yesterday' : 'Earlier');

  let toastTimer;
  function toast(text) {
    const el = $('#toast');
    el.textContent = text;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
  }

  async function api(method, path, body) {
    const res = await fetch(path, {
      method,
      headers: { 'x-muser-token': TOKEN, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 204) return null;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  // ---------------------------------------------------------------- state
  const S = {
    agents: [], chats: [], settings: null, active: null, limits: {},
    agentId: null, chat: null, // chat: full chat object, or null for a not-yet-created new chat
    drawerOpen: false, search: '', renaming: null,
    stream: null, // { chatId, ac, el, msg, stopping }
  };
  const agent = () => S.agents.find((a) => a.id === S.agentId) || S.agents[0];
  const agentById = (id) => S.agents.find((a) => a.id === id);

  async function refreshState() {
    const st = await api('GET', '/api/state');
    Object.assign(S, { agents: st.agents, chats: st.chats, settings: st.settings, active: st.active, limits: st.limits, suggested: st.suggestedFolders || [] });
  }

  // ---------------------------------------------------------------- rendering: chrome
  function renderRail() {
    const rail = $('#rail');
    rail.replaceChildren(
      h('button', { class: 'rail-btn', title: 'Chats', 'aria-label': 'Chats', 'aria-pressed': S.drawerOpen, onclick: toggleDrawer }, icon('chat')),
      h('button', { class: 'rail-btn', id: 'new-chat-btn', title: 'New chat (Ctrl/⌘ N)', 'aria-label': 'New chat', onclick: () => newChat() }, icon('compose')),
      h('div', { class: 'rail-sep' }),
      ...S.agents.map((a) =>
        h('button', { class: 'rail-btn rail-agent', title: a.name, 'aria-label': `Chat with ${a.name}`, 'aria-current': a.id === S.agentId, 'data-agent': a.id, onclick: () => switchAgent(a.id) }, avatar(a)),
      ),
      h('button', { class: 'rail-btn', id: 'new-agent-btn', title: 'New agent', 'aria-label': 'New agent', onclick: () => openAgentSheet(null) }, icon('plus')),
      h('div', { class: 'rail-spacer' }),
      h('button', { class: 'rail-btn', id: 'settings-btn', title: 'Settings (Ctrl/⌘ ,)', 'aria-label': 'Settings', onclick: openSettings }, icon('settings')),
    );
  }

  function renderTopbar() {
    const a = agent();
    $('#topbar').replaceChildren(
      h('button', { class: 'pill', id: 'chats-btn', 'aria-label': 'Chats', 'aria-expanded': S.drawerOpen, onclick: toggleDrawer }, icon('menu', 18), 'Chats'),
      h('button', { id: 'agent-chip', title: `Edit ${a.name}`, 'aria-label': `${a.name}: edit agent and instructions`, onclick: () => openAgentSheet(a) }, avatar(a), h('span', { class: 'name' }, a.name)),
    );
  }

  function renderNotice() {
    const el = $('#notice');
    if (S.active && S.active.provider === 'demo') {
      el.hidden = false;
      el.replaceChildren(h('span', {}, 'Demo mode: replies are generated locally. Add an API key for real answers.'), h('button', { type: 'button', onclick: openSettings }, 'Settings'));
    } else el.hidden = true;
  }

  function renderComposer() {
    const form = $('#composer');
    const old = $('textarea', form);
    const keep = old ? old.value : '';
    const streaming = !!S.stream;
    const ta = h('textarea', { id: 'input', rows: '1', placeholder: 'Message', 'aria-label': 'Message', maxlength: String(S.limits.message || 20000) });
    ta.value = keep;
    const grow = () => { ta.style.height = 'auto'; ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`; if (!streaming) sendBtn.disabled = !ta.value.trim(); };
    const sendBtn = streaming
      ? h('button', { type: 'button', class: 'round stop', id: 'stop-btn', title: 'Stop (Esc)', 'aria-label': 'Stop', onclick: stopStreaming }, icon('stop', 18))
      : h('button', { type: 'submit', class: 'round send', id: 'send-btn', title: 'Send', 'aria-label': 'Send', disabled: true }, icon('send', 20));
    ta.addEventListener('input', grow);
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); }
      else if (e.key === 'Escape' && S.stream) { e.preventDefault(); stopStreaming(); }
    });
    form.replaceChildren(
      h('button', { type: 'button', class: 'round', id: 'plus-btn', title: 'More', 'aria-label': 'More actions', onclick: (e) => openPlusMenu(e.currentTarget) }, icon('plus')),
      ta,
      sendBtn,
    );
    grow();
    if (document.activeElement === document.body || old === document.activeElement || !old) ta.focus();
  }

  // ---------------------------------------------------------------- rendering: thread
  const nearBottom = () => { const f = $('#feed'); return f.scrollHeight - f.scrollTop - f.clientHeight < 140; };
  const scrollDown = () => { const f = $('#feed'); f.scrollTop = f.scrollHeight; };

  function fillBubble(el, msg) {
    if (msg.role === 'user') { el.textContent = msg.content; return; }
    if (!msg.content && msg.status === 'streaming' && !(msg.toolCalls && msg.toolCalls.length)) { el.hidden = false; el.replaceChildren(h('span', { class: 'typing', 'aria-label': 'Typing' }, h('i'), h('i'), h('i'))); return; }
    el.hidden = !msg.content;
    el.innerHTML = msg.content ? md.render(msg.content) : '';
    el.classList.toggle('caret', msg.status === 'streaming' && !!msg.content && !(msg.toolCalls && msg.toolCalls.length));
  }

  const TOOL_LABELS = { make_folder: 'Create folders', move_files: 'Move files', trash_files: 'Move to Trash', write_file: 'Create or replace files' };
  const openDetails = new Set(); // call ids whose "Task summary" is expanded

  // The permission card: the exact plan, built by the server from the validated request.
  function approvalCard(call) {
    const open = openDetails.has(call.id);
    const ask = (decision) => decide(call, decision);
    return h('div', { class: 'approval', role: 'group', 'aria-label': call.title, 'data-call': call.id },
      h('div', { class: 'ap-head' }, icon('monitor', 17), h('span', {}, call.title)),
      h('button', { class: 'ap-summary', type: 'button', 'aria-expanded': String(open), onclick: () => { open ? openDetails.delete(call.id) : openDetails.add(call.id); replaceCard(call); } },
        h('span', { class: 'txt' }, h('span', { class: 'k' }, 'Task summary'), h('span', { class: 'v' }, call.summary)),
        h('span', { class: `chev${open ? ' up' : ''}` }, icon('chevron', 16))),
      open && h('ul', { class: 'ap-items' }, ...(call.items || []).map((i) => h('li', {}, i))),
      h('div', { class: 'ap-actions' },
        h('button', { class: 'ap-btn primary', type: 'button', 'data-decision': 'allow', onclick: () => ask('allow') }, 'Allow'),
        h('button', { class: 'ap-btn', type: 'button', 'data-decision': 'always', title: `Always allow “${TOOL_LABELS[call.name] || call.name}” for ${agent().name}`, onclick: () => ask('always') }, 'Always allow'),
        h('button', { class: 'ap-btn', type: 'button', 'data-decision': 'deny', onclick: () => ask('deny') }, 'Deny')),
    );
  }

  // Everything that is not waiting on you: a quiet one-line record of what happened.
  function activityEl(call) {
    const st = call.status;
    const label = call.label || call.name;
    let text;
    if (st === 'running' || st === 'pending') text = `${label}…`;
    else if (st === 'done') text = call.outcome || label;
    else if (st === 'denied') text = `Denied: ${label}`;
    else if (st === 'cancelled') text = `Cancelled: ${label}`;
    else if (st === 'interrupted') text = call.outcome || `Interrupted: ${label}`;
    else text = `Could not ${label.charAt(0).toLowerCase()}${label.slice(1)}: ${call.error || 'something went wrong'}`;
    const bad = st === 'error' || st === 'interrupted';
    const mark = st === 'done' ? icon('check', 14) : st === 'running' || st === 'pending' ? h('span', { class: 'spin', 'aria-hidden': 'true' }) : icon('x', 14);
    const head = h('span', { class: 'a-line' }, mark, h('span', {}, text));
    const hasItems = st === 'done' && !call.readOnly && call.items && call.items.length;
    const el = hasItems
      ? h('details', { class: 'activity', 'data-call': call.id, 'data-status': st }, h('summary', {}, head), h('ul', { class: 'ap-items' }, ...call.items.map((i) => h('li', {}, i))))
      : h('div', { class: `activity${bad ? ' bad' : ''}`, 'data-call': call.id, 'data-status': st }, head);
    return el;
  }

  const cardEl = (call) => (call.status === 'awaiting' ? approvalCard(call) : activityEl(call));
  function replaceCard(call) {
    const old = document.querySelector(`[data-call="${call.id}"]`);
    if (old) old.replaceWith(cardEl(call));
  }

  async function decide(call, decision) {
    const card = document.querySelector(`[data-call="${call.id}"]`);
    card && card.querySelectorAll('button').forEach((b) => { b.disabled = true; });
    try {
      await api('POST', `/api/chats/${S.chat.id}/approve`, { callId: call.id, decision });
    } catch (err) {
      card && card.querySelectorAll('button').forEach((b) => { b.disabled = false; });
      toast(err.message);
    }
  }

  function messageEl(msg, { last, live = false }) {
    const wrap = h('div', { class: `msg ${msg.role}${last ? ' last' : ''}`, 'data-id': msg.id });
    const bubble = h('div', { class: 'bubble' });
    fillBubble(bubble, msg);
    wrap.append(bubble);
    if (msg.role === 'assistant') {
      const calls = msg.toolCalls || [];
      const cards = h('div', { class: 'cards' }, ...calls.map(cardEl));
      cards.hidden = !calls.length;
      wrap.append(cards);
      if (!live && msg.status !== 'streaming') wrap.append(...assistantFooter(msg, last));
    } else wrap.append(h('div', { class: 'actions' }, h('button', { class: 'act', type: 'button', title: 'Copy', 'aria-label': 'Copy message', onclick: () => copyText(msg.content) }, icon('copy', 15))));
    return wrap;
  }

  function assistantFooter(msg, last) {
    const parts = [];
    if (msg.status === 'error') parts.push(h('div', { class: 'errbox', role: 'alert' }, msg.error || 'Something went wrong.'));
    const bar = h('div', { class: 'actions' });
    if (msg.content) bar.append(h('button', { class: 'act', type: 'button', 'aria-label': 'Copy reply', onclick: () => copyText(msg.content) }, icon('copy', 15), 'Copy'));
    if (msg.status === 'stopped') bar.append(h('span', { class: 'note' }, 'Stopped'));
    if (msg.status === 'interrupted') bar.append(h('span', { class: 'note' }, 'Reply was interrupted'));
    if (last) bar.append(h('button', { class: `act${msg.status === 'done' ? '' : ' primary'}`, type: 'button', 'data-act': 'retry', 'aria-label': 'Retry', onclick: retry }, icon('retry', 15), 'Retry'));
    if (bar.children.length) parts.push(bar);
    return parts;
  }

  function renderThread({ keepScroll = false } = {}) {
    const thread = $('#thread');
    const stick = !keepScroll || nearBottom();
    thread.replaceChildren();
    const msgs = S.chat ? S.chat.messages : [];
    if (!msgs.length) {
      const a = agent();
      thread.append(h('div', { class: 'empty' }, avatar(a), h('h1', {}, a.name), a.role && h('p', {}, a.role), h('small', {}, 'Previous chats stay in Chats.')));
      return;
    }
    let prev = 0;
    msgs.forEach((m, i) => {
      if (!prev || m.createdAt - prev > 15 * 60 * 1000) thread.append(h('div', { class: 'stamp' }, stamp(m.createdAt)));
      prev = m.createdAt;
      thread.append(messageEl(m, { last: i === msgs.length - 1, live: !!(S.stream && S.stream.cur && S.stream.cur.msg === m) }));
    });
    if (stick) scrollDown();
  }

  function renderAll() {
    renderRail();
    renderTopbar();
    renderNotice();
    renderThread();
    renderComposer();
    renderDrawer();
  }

  // ---------------------------------------------------------------- actions: navigation
  async function stopIfStreaming() {
    if (!S.stream) return;
    stopStreaming();
    for (let i = 0; i < 100 && S.stream; i++) await new Promise((r) => setTimeout(r, 20));
  }

  async function openChat(id) {
    await stopIfStreaming();
    const { chat } = await api('GET', `/api/chats/${id}`);
    S.chat = chat;
    S.agentId = chat.agentId;
    closeDrawer();
    renderAll();
    scrollDown();
  }

  async function newChat(agentId) {
    await stopIfStreaming();
    if (agentId) S.agentId = agentId;
    S.chat = null;
    closeDrawer();
    renderAll();
    $('#input').focus();
  }

  async function switchAgent(id) {
    const latest = S.chats.find((c) => c.agentId === id);
    if (id === S.agentId && S.chat && S.chat.messages.length === 0) return;
    if (latest) await openChat(latest.id);
    else await newChat(id);
  }

  // ---------------------------------------------------------------- actions: streaming
  function parseSse(buffer, onEvent) {
    let i;
    while ((i = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, i);
      buffer = buffer.slice(i + 2);
      if (block.startsWith('data: ')) onEvent(JSON.parse(block.slice(6)));
    }
    return buffer;
  }

  let rafPending = false;
  function paintStream() {
    if (rafPending || !S.stream) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      const cur = S.stream && S.stream.cur;
      if (!cur) return;
      const stick = nearBottom();
      fillBubble(cur.bubble, cur.msg);
      if (stick) scrollDown();
    });
  }

  function announce(text) { const el = $('#live'); if (el) { el.textContent = ''; setTimeout(() => { el.textContent = text; }, 30); } }

  // One live assistant message: a text bubble plus a slot for tool cards. A turn can have several.
  function liveMessage(msg) {
    const last = document.querySelector('#thread .msg.last');
    last && last.classList.remove('last');
    const wrap = messageEl(msg, { last: true, live: true });
    $('#thread').append(wrap);
    const cur = { msg, wrap, bubble: $('.bubble', wrap), cards: $('.cards', wrap) };
    if (S.stream) S.stream.cur = cur;
    return cur;
  }

  async function runStream(path, body) {
    const chat = S.chat;
    const ac = new AbortController();
    S.stream = { chatId: chat.id, ac, cur: null, stopping: false };
    const placeholder = { id: 'pending', role: 'assistant', content: '', status: 'streaming', createdAt: Date.now(), toolCalls: [] };
    liveMessage(placeholder);
    renderComposer();
    scrollDown();
    let finished = false;
    let started = false;
    const finish = (final) => {
      if (finished) return;
      finished = true;
      const cur = S.stream && S.stream.cur;
      if (cur) {
        Object.assign(cur.msg, final);
        if (!chat.messages.includes(cur.msg)) chat.messages.push({ ...cur.msg, id: cur.msg.id === 'pending' ? `err_${Date.now()}` : cur.msg.id });
      }
      S.stream = null;
      renderThread({ keepScroll: true });
      renderComposer();
      // The server is the source of truth: re-sync once the turn is over.
      api('GET', `/api/chats/${chat.id}`).then(({ chat: fresh }) => {
        if (S.chat && S.chat.id === fresh.id && !S.stream) { S.chat = fresh; renderThread({ keepScroll: true }); }
      }).catch(() => {});
      refreshState().then(() => { renderRail(); renderTopbar(); renderNotice(); renderDrawer(); }).catch(() => {});
    };
    const onEvent = (e) => {
      const cur = S.stream && S.stream.cur;
      if (e.t === 'start') {
        started = true;
        if (e.userMessage) {
          const local = chat.messages.findIndex((m) => String(m.id).startsWith('local_'));
          if (local >= 0) chat.messages[local] = e.userMessage;
          else if (!chat.messages.some((m) => m.id === e.userMessage.id)) chat.messages.push(e.userMessage);
        }
        Object.assign(cur.msg, e.assistantMessage, { toolCalls: e.assistantMessage.toolCalls || [] });
        chat.messages.push(cur.msg);
        chat.title = e.title;
      } else if (e.t === 'delta') {
        cur.msg.content += e.text;
        paintStream();
      } else if (e.t === 'tools') {
        cur.msg.toolCalls = e.calls;
        cur.cards.replaceChildren(...e.calls.map(cardEl));
        cur.cards.hidden = false;
        fillBubble(cur.bubble, cur.msg);
        scrollDown();
      } else if (e.t === 'tool') {
        const i = cur.msg.toolCalls.findIndex((c) => c.id === e.call.id);
        if (i >= 0) cur.msg.toolCalls[i] = e.call; else cur.msg.toolCalls.push(e.call);
        const old = cur.cards.querySelector(`[data-call="${e.call.id}"]`);
        const el = cardEl(e.call);
        if (old) old.replaceWith(el); else cur.cards.append(el);
        if (e.call.status === 'awaiting') { announce(`${agent().name} is asking permission: ${e.call.title}`); }
        scrollDown();
      } else if (e.t === 'next') {
        cur.msg.status = 'done';
        liveMessage(e.message);
        chat.messages.push(S.stream.cur.msg);
        scrollDown();
      } else if (e.t === 'done') finish(e.message);
    };
    try {
      const res = await fetch(path, { method: 'POST', signal: ac.signal, headers: { 'x-muser-token': TOKEN, 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Request failed (${res.status})`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf = parseSse(buf + decoder.decode(value, { stream: true }), onEvent);
      }
      if (!finished) finish({ status: S.stream && S.stream.cur && S.stream.cur.msg.content ? 'interrupted' : 'error', error: 'The connection closed before the reply finished.' });
    } catch (err) {
      if (!finished && !started && err.name !== 'AbortError') {
        // The server never accepted this request: undo the UI and let the caller recover.
        finished = true;
        S.stream = null;
        return { ok: false, error: err.message };
      }
      if (!finished) {
        if (err.name === 'AbortError') finish({ status: 'stopped' });
        else finish({ status: 'error', error: 'The connection was lost.' });
      }
    }
    return { ok: true };
  }

  async function sendMessage(text) {
    if (S.stream) return;
    if (!S.chat) {
      try { S.chat = (await api('POST', '/api/chats', { agentId: S.agentId })).chat; }
      catch (err) { return toast(err.message); }
    }
    const chat = S.chat;
    // Optimistic user bubble (the server's "start" event confirms it).
    const optimistic = { id: `local_${Date.now()}`, role: 'user', content: text, status: 'done', createdAt: Date.now() };
    chat.messages.push(optimistic);
    renderThread();
    const input = $('#input');
    input.value = '';
    input.style.height = 'auto';
    const out = await runStream(`/api/chats/${chat.id}/send`, { text });
    if (!out.ok) {
      chat.messages = chat.messages.filter((m) => m !== optimistic);
      renderThread();
      renderComposer();
      const box = $('#input');
      box.value = text;
      box.dispatchEvent(new Event('input'));
      toast(out.error);
    }
  }

  async function stopStreaming() {
    const st = S.stream;
    if (!st || st.stopping) return;
    st.stopping = true;
    try { await api('POST', `/api/chats/${st.chatId}/stop`); }
    catch { st.ac.abort(); return; }
    // The server finishes the stream with a "done: stopped" event. If it never arrives, abort locally.
    setTimeout(() => { if (S.stream === st) st.ac.abort(); }, 1500);
  }

  async function retry() {
    if (S.stream || !S.chat) return;
    const msgs = S.chat.messages;
    const tail = msgs[msgs.length - 1];
    if (tail && tail.role === 'assistant' && !(tail.toolCalls && tail.toolCalls.length)) msgs.pop();
    renderThread();
    const out = await runStream(`/api/chats/${S.chat.id}/retry`);
    if (!out.ok) {
      toast(out.error);
      const { chat } = await api('GET', `/api/chats/${S.chat.id}`).catch(() => ({}));
      if (chat) S.chat = chat;
      renderThread();
      renderComposer();
    }
  }

  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); toast('Copied'); }
    catch { toast('Copy is not available here'); }
  }

  // ---------------------------------------------------------------- drawer (Chats)
  function toggleDrawer() { S.drawerOpen ? closeDrawer() : openDrawer(); }
  function openDrawer() { S.drawerOpen = true; S.search = ''; renderDrawer(); renderRail(); $('#chats-btn').setAttribute('aria-expanded', 'true'); const s = $('#drawer input[type=search]'); s && s.focus(); }
  function closeDrawer() { if (!S.drawerOpen) return; S.drawerOpen = false; S.renaming = null; renderDrawer(); renderRail(); const b = $('#chats-btn'); b && b.setAttribute('aria-expanded', 'false'); }

  function renderDrawer() {
    const drawer = $('#drawer');
    const scrim = $('#scrim');
    drawer.hidden = scrim.hidden = !S.drawerOpen;
    if (!S.drawerOpen) { drawer.replaceChildren(); return; }
    scrim.onclick = closeDrawer;
    const q = S.search.trim().toLowerCase();
    const list = S.chats.filter((c) => !q || c.title.toLowerCase().includes(q) || c.preview.toLowerCase().includes(q));
    const groups = {};
    for (const c of list) (groups[groupOf(c)] ||= []).push(c);
    const body = h('div', { class: 'chat-list' });
    if (!list.length) body.append(h('div', { class: 'list-empty' }, S.chats.length ? 'No chats match your search.' : 'No chats yet. Say hello to start one.'));
    for (const label of ['Pinned', 'Today', 'Yesterday', 'Earlier']) {
      if (!groups[label]) continue;
      body.append(h('div', { class: 'group-label' }, label), ...groups[label].map(chatRow));
    }
    const search = h('input', { type: 'search', placeholder: 'Search chats', 'aria-label': 'Search chats', value: S.search });
    search.addEventListener('input', () => { S.search = search.value; const pos = search.selectionStart; renderDrawer(); const s2 = $('#drawer input[type=search]'); s2.focus(); s2.setSelectionRange(pos, pos); });
    drawer.replaceChildren(
      h('div', { class: 'drawer-head' }, h('h2', {}, 'Chats'), h('span', { class: 'head-actions' }, h('button', { class: 'act primary', type: 'button', 'aria-label': 'New chat', onclick: () => newChat() }, icon('compose', 16), 'New chat'), h('button', { class: 'act', type: 'button', id: 'close-drawer', 'aria-label': 'Close chats', onclick: closeDrawer }, icon('x', 18)))),
      h('label', { class: 'search' }, icon('search', 16), search),
      body,
    );
  }

  function chatRow(c) {
    const a = agentById(c.agentId) || { emoji: '🙂', color: '#eee', name: '?' };
    const current = S.chat && S.chat.id === c.id;
    const row = h('div', { class: `chat-item${current ? ' current' : ''}`, 'data-chat': c.id });
    if (S.renaming === c.id) {
      const input = h('input', { class: 'rename', value: c.title, 'aria-label': 'Chat title', maxlength: '120' });
      let done = false;
      const commit = async (save) => {
        if (done) return; done = true; S.renaming = null;
        const next = input.value.trim();
        if (save && next && next !== c.title) {
          try { await api('PATCH', `/api/chats/${c.id}`, { title: next }); if (S.chat && S.chat.id === c.id) S.chat.title = next; await refreshState(); } catch (err) { toast(err.message); }
        }
        renderDrawer();
      };
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') commit(true); else if (e.key === 'Escape') { e.stopPropagation(); commit(false); } });
      input.addEventListener('blur', () => commit(true));
      row.append(avatar(a, 34), input);
      setTimeout(() => { input.focus(); input.select(); }, 0);
      return row;
    }
    const stop = (fn) => (e) => { e.stopPropagation(); fn(); };
    row.append(
      avatar(a, 34),
      h('button', { class: 'body', type: 'button', onclick: () => openChat(c.id) }, h('span', { class: 't' }, c.title), h('span', { class: 's' }, `${stamp(c.updatedAt)}${c.preview ? ` · ${c.preview}` : ''}`)),
      h('div', { class: 'row-actions' },
        h('button', { class: 'act', type: 'button', 'data-act': 'pin', title: c.pinned ? 'Unpin' : 'Pin', 'aria-label': c.pinned ? 'Unpin chat' : 'Pin chat', onclick: stop(() => togglePin(c)) }, icon('pin', 15)),
        h('button', { class: 'act', type: 'button', 'data-act': 'rename', title: 'Rename', 'aria-label': 'Rename chat', onclick: stop(() => { S.renaming = c.id; renderDrawer(); }) }, icon('edit', 15)),
        h('button', { class: 'act', type: 'button', 'data-act': 'delete', title: 'Delete', 'aria-label': 'Delete chat', onclick: stop(() => deleteChat(c)) }, icon('trash', 15)),
      ),
    );
    return row;
  }

  async function togglePin(c) {
    try { await api('PATCH', `/api/chats/${c.id}`, { pinned: !c.pinned }); await refreshState(); renderDrawer(); } catch (err) { toast(err.message); }
  }

  async function deleteChat(c) {
    const ok = await confirmDialog({ title: 'Delete this chat?', body: `“${c.title}” and its messages will be removed from this computer.`, confirm: 'Delete', danger: true });
    if (!ok) return;
    try {
      const wasCurrent = S.chat && S.chat.id === c.id;
      if (wasCurrent) await stopIfStreaming();
      await api('DELETE', `/api/chats/${c.id}`);
      await refreshState();
      if (wasCurrent) S.chat = null;
      renderAll();
      toast('Chat deleted');
    } catch (err) { toast(err.message); }
  }

  // ---------------------------------------------------------------- overlays
  function overlay(build) {
    const root = $('#overlay-root');
    const prevFocus = document.activeElement;
    const back = h('div', { class: 'modal-back' });
    const close = () => { back.remove(); document.removeEventListener('keydown', onKey, true); prevFocus && prevFocus.focus && prevFocus.focus(); };
    const api2 = { close, back, canClose: () => true, requestClose: () => api2.canClose() && close() };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); api2.requestClose(); }
      if (e.key === 'Tab') { // keep focus inside the dialog
        const f = [...back.querySelectorAll('button, input, textarea, select, [tabindex]')].filter((x) => !x.disabled && x.tabIndex >= 0);
        if (!f.length) return;
        const first = f[0], last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', onKey, true);
    back.addEventListener('mousedown', (e) => { if (e.target === back) api2.requestClose(); });
    const modal = build(api2);
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    back.append(modal);
    root.append(back);
    const focus = modal.querySelector('[data-autofocus]') || modal.querySelector('input, textarea, button');
    focus && focus.focus();
    return api2;
  }

  function confirmDialog({ title, body, confirm, danger }) {
    return new Promise((resolve) => {
      let settled = false;
      const settle = (v, o) => { if (!settled) { settled = true; resolve(v); o.close(); } };
      overlay((o) => {
        o.requestClose = () => settle(false, o);
        return h('div', { class: 'modal', 'aria-label': title },
          h('h2', {}, title), h('p', { class: 'sub' }, body),
          h('div', { class: 'modal-actions' },
            h('button', { class: 'btn', type: 'button', onclick: () => settle(false, o) }, 'Cancel'),
            h('button', { class: `btn ${danger ? 'danger solid' : 'primary'}`, type: 'button', 'data-autofocus': true, onclick: () => settle(true, o) }, confirm)),
        );
      });
    });
  }

  function openPlusMenu(anchor) {
    const old = $('.popover'); if (old) { old.remove(); return; }
    const r = anchor.getBoundingClientRect();
    const items = [['New chat', 'compose', () => newChat()], ['Edit instructions', 'edit', () => openAgentSheet(agent())], ['Share a folder…', 'folder', openSettings], ['Settings', 'settings', openSettings]];
    const pop = h('div', { class: 'popover', role: 'menu' }, items.map(([label, ic, fn]) => h('button', { type: 'button', role: 'menuitem', onclick: () => { pop.remove(); fn(); } }, icon(ic, 18), label)));
    document.body.append(pop);
    pop.style.left = `${Math.max(8, r.left)}px`;
    pop.style.bottom = `${window.innerHeight - r.top + 8}px`;
    const off = (e) => { if (!pop.contains(e.target)) { pop.remove(); document.removeEventListener('mousedown', off, true); } };
    document.addEventListener('mousedown', off, true);
    pop.querySelector('button').focus();
    pop.addEventListener('keydown', (e) => { if (e.key === 'Escape') { pop.remove(); anchor.focus(); } });
  }

  // ---------------------------------------------------------------- agent sheet (new / edit)
  const PRESETS = [
    { id: 'blank', label: 'Blank', name: '', role: '', emoji: '🙂', instructions: '' },
    { id: 'planner', label: 'Planner', name: 'Planner', role: 'Plans your days and projects', emoji: '🗓️', instructions: 'Turn goals into short, realistic plans. Ask what the deadline is if it is missing. Break work into concrete next actions and keep lists tight.' },
    { id: 'researcher', label: 'Researcher', name: 'Scout', role: 'Digs into questions and summarizes', emoji: '🔎', instructions: 'Answer with the key finding first, then the evidence. Say clearly when you are unsure or when something may be out of date. Never invent sources.' },
    { id: 'coach', label: 'Writing coach', name: 'Quill', role: 'Sharpens your writing', emoji: '✍️', instructions: 'Give direct, kind feedback on clarity and tone. Show a tightened rewrite, then list the two or three changes that mattered most.' },
    { id: 'study', label: 'Study buddy', name: 'Sage', role: 'Explains things step by step', emoji: '📚', instructions: 'Explain ideas simply, with one concrete example. Check understanding with a short question at the end.' },
  ];
  const EMOJIS = ['🙂', '🪶', '🗓️', '🔎', '✍️', '📚', '🧠', '💡', '🛠️', '🌿', '🎯', '🍳'];
  const COLORS = ['#cfe3ff', '#ffe2c7', '#d9f0d2', '#f3d4ee', '#fff0b8', '#d4ecf0'];

  function openAgentSheet(existing) {
    const isNew = !existing;
    const lim = S.limits;
    const draft = existing ? { ...existing, alwaysAllow: [...(existing.alwaysAllow || [])] } : { name: '', role: '', emoji: '🙂', color: COLORS[S.agents.length % COLORS.length], instructions: '', alwaysAllow: [] };
    const snap = () => JSON.stringify([draft.name, draft.role, draft.emoji, draft.color, draft.instructions, draft.alwaysAllow]);
    const base = snap();
    const dirty = () => snap() !== base;

    overlay((o) => {
      const err = h('p', { class: 'err-line', role: 'alert' });
      const preview = h('span', {});
      const paintPreview = () => preview.replaceChildren(avatar(draft, 52));
      paintPreview();

      const name = h('input', { class: 'input', id: 'f-name', value: draft.name, maxlength: String(lim.name), placeholder: 'e.g. Planner', 'data-autofocus': true });
      const role = h('input', { class: 'input', id: 'f-role', value: draft.role, maxlength: String(lim.role), placeholder: 'What this agent is for' });
      const emoji = h('input', { class: 'input', id: 'f-emoji', value: draft.emoji, maxlength: '8', 'aria-label': 'Avatar emoji', style: { width: '92px', textAlign: 'center' } });
      const instr = h('textarea', { class: 'input', id: 'f-instr', placeholder: 'How should this agent behave? These apply to every reply.' });
      instr.value = draft.instructions;
      const counter = h('em', {});
      const save = h('button', { class: 'btn primary', type: 'submit', id: 'save-agent' }, isNew ? 'Create agent' : 'Save');

      // Actions this agent may do without asking. Revoking is one click.
      const allowBox = h('div', { class: 'field', id: 'allow-box' });
      const paintAllow = () => {
        allowBox.hidden = !draft.alwaysAllow.length;
        allowBox.replaceChildren(
          h('span', {}, 'Always allowed', h('em', {}, 'no approval needed')),
          h('div', { class: 'chips', style: { marginBottom: '0' } }, ...draft.alwaysAllow.map((n) =>
            h('button', { class: 'chip', type: 'button', 'data-revoke': n, title: 'Ask me again', 'aria-label': `Stop always allowing: ${TOOL_LABELS[n] || n}`, onclick: () => { draft.alwaysAllow = draft.alwaysAllow.filter((x) => x !== n); paintAllow(); sync(); } }, `${TOOL_LABELS[n] || n}  ✕`))),
        );
      };
      paintAllow();

      const sync = () => {
        draft.name = name.value; draft.role = role.value; draft.emoji = emoji.value.trim() || '🙂'; draft.instructions = instr.value;
        counter.textContent = `${instr.value.length.toLocaleString()} / ${lim.instructions.toLocaleString()}`;
        counter.classList.toggle('over', instr.value.length > lim.instructions);
        save.disabled = !name.value.trim() || instr.value.length > lim.instructions || (!isNew && !dirty());
        paintPreview();
      };
      [name, role, emoji, instr].forEach((el) => el.addEventListener('input', sync));

      const presetBtns = PRESETS.map((p) => h('button', { class: 'chip', type: 'button', 'data-preset': p.id, 'aria-pressed': 'false', onclick: () => {
        name.value = p.name; role.value = p.role; emoji.value = p.emoji; instr.value = p.instructions;
        presetBtns.forEach((b) => b.setAttribute('aria-pressed', String(b === presetBtns[PRESETS.indexOf(p)])));
        sync(); name.focus();
      } }, p.label));

      const swatches = h('div', { class: 'swatches', role: 'group', 'aria-label': 'Avatar color' }, COLORS.map((c) => h('button', { type: 'button', class: 'swatch', 'aria-label': `Color ${c}`, 'aria-pressed': String(c === draft.color), style: { background: c }, onclick: (e) => {
        draft.color = c; swatches.querySelectorAll('.swatch').forEach((b) => b.setAttribute('aria-pressed', String(b === e.currentTarget))); sync();
      } })));
      const emojiRow = h('div', { class: 'emoji-row' }, EMOJIS.map((e) => h('button', { type: 'button', 'aria-label': `Use ${e}`, onclick: () => { emoji.value = e; sync(); } }, e)));

      o.canClose = () => !dirty() || (confirmDialog({ title: 'Discard changes?', body: 'Your edits to this agent have not been saved.', confirm: 'Discard', danger: true }).then((ok) => ok && o.close()), false);

      const form = h('form', { class: 'modal', 'aria-label': isNew ? 'New agent' : 'Edit agent', onsubmit: async (e) => {
        e.preventDefault(); sync();
        if (save.disabled) return;
        save.disabled = true; err.textContent = '';
        try {
          const payload = { name: draft.name, role: draft.role, emoji: draft.emoji, color: draft.color, instructions: draft.instructions, alwaysAllow: draft.alwaysAllow };
          if (isNew) {
            const { agent: created } = await api('POST', '/api/agents', payload);
            await refreshState();
            o.close();
            await newChat(created.id);
            toast(`${created.name} is ready`);
          } else {
            await api('PATCH', `/api/agents/${existing.id}`, payload);
            await refreshState();
            o.close();
            renderAll();
            toast('Saved. New replies will use these instructions.');
          }
        } catch (ex) { err.textContent = ex.message; save.disabled = false; }
      } },
        h('h2', {}, isNew ? 'New agent' : `Edit ${existing.name}`),
        h('p', { class: 'sub' }, isNew ? 'Start blank or pick a preset, then edit the name, role and instructions before you create it.' : 'Instructions are included in every reply this agent gives, in new and existing chats.'),
        isNew && h('div', { class: 'chips', role: 'group', 'aria-label': 'Presets' }, presetBtns),
        h('div', { class: 'picker' }, preview, h('div', { style: { flex: '1' } }, h('label', { class: 'field', style: { margin: '0' } }, h('span', {}, 'Avatar'), emoji))),
        emojiRow, swatches,
        h('label', { class: 'field' }, h('span', {}, 'Name'), name),
        h('label', { class: 'field' }, h('span', {}, 'Role', h('em', {}, 'optional')), role),
        h('label', { class: 'field' }, h('span', {}, 'Instructions', counter), instr),
        allowBox,
        err,
        h('div', { class: 'modal-actions' },
          !isNew && S.agents.length > 1 && h('button', { class: 'btn danger', type: 'button', id: 'delete-agent', onclick: async () => {
            const ok = await confirmDialog({ title: `Delete ${existing.name}?`, body: 'This agent and all of its chats will be removed from this computer.', confirm: 'Delete agent', danger: true });
            if (!ok) return;
            try { await stopIfStreaming(); await api('DELETE', `/api/agents/${existing.id}`); await refreshState(); const gone = S.agentId === existing.id; o.close(); if (gone) { S.agentId = S.agents[0].id; S.chat = null; } renderAll(); toast('Agent deleted'); } catch (ex) { err.textContent = ex.message; }
          } }, 'Delete agent'),
          h('span', { class: 'spacer' }),
          h('button', { class: 'btn', type: 'button', onclick: () => o.requestClose() }, 'Cancel'),
          save),
      );
      sync();
      return form;
    });
  }

  // ---------------------------------------------------------------- settings
  function openSettings() {
    const st = S.settings;
    const draft = { provider: st.provider, openaiModel: st.openaiModel, anthropicModel: st.anthropicModel, keys: {} };
    const folderErr = h('p', { class: 'err-line', role: 'alert' });
    const folderList = h('div', { class: 'folder-list', id: 'folder-list' });
    const setFolders = async (folders) => {
      folderErr.textContent = '';
      try {
        const out = await api('PUT', '/api/settings', { folders });
        S.settings = out.settings; S.active = out.active;
        await refreshState();
        paintFolders();
      } catch (ex) { folderErr.textContent = ex.message; }
    };
    const paintFolders = () => {
      folderList.replaceChildren(
        ...(S.settings.folders.length ? S.settings.folders.map((f) => h('div', { class: 'folder-row' }, icon('folder', 16), h('span', { class: 'path', title: f }, f), h('button', { class: 'act', type: 'button', 'data-remove-folder': f, 'aria-label': `Stop sharing ${f}`, onclick: () => setFolders(S.settings.folders.filter((x) => x !== f)) }, icon('x', 14)))) : [h('p', { class: 'hint', style: { margin: '0 0 8px' } }, 'No folders shared yet. Agents cannot see your files.')]),
        ...S.suggested.map((sg) => h('button', { class: 'chip', type: 'button', 'data-suggest': sg.name, onclick: () => setFolders([...S.settings.folders, sg.path]) }, `Share ${sg.name}`)),
      );
    };
    paintFolders();
    overlay((o) => {
      const err = h('p', { class: 'err-line', role: 'alert' });
      const summary = h('p', { class: 'hint' });
      const label = { auto: 'Auto', openai: 'OpenAI', anthropic: 'Anthropic', demo: 'Demo' };
      const seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Provider' }, Object.keys(label).map((k) => h('button', { type: 'button', 'data-provider': k, 'aria-pressed': String(draft.provider === k), onclick: () => { draft.provider = k; seg.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.provider === k))); } }, label[k])));
      const keyField = (prov, title) => {
        const input = h('input', { class: 'input', type: 'password', autocomplete: 'off', spellcheck: 'false', 'aria-label': `${title} API key`, placeholder: st.savedKey[prov] ? 'Saved. Type to replace' : st.envKey[prov] ? 'Using the key from your environment' : 'Paste your key' });
        input.addEventListener('input', () => { draft.keys[prov] = input.value.trim(); });
        const clear = st.savedKey[prov] && h('button', { class: 'act', type: 'button', onclick: () => { draft.keys[prov] = ''; input.value = ''; input.placeholder = 'Key will be removed'; } }, 'Remove saved key');
        return h('label', { class: 'field' }, h('span', {}, `${title} API key`, clear), input);
      };
      const model = (prov, title) => { const i = h('input', { class: 'input', value: draft[`${prov}Model`], 'aria-label': `${title} model` }); i.addEventListener('input', () => { draft[`${prov}Model`] = i.value; }); return h('label', { class: 'field' }, h('span', {}, `${title} model`), i); };
      const a = S.active;
      summary.textContent = `Currently using: ${a.provider === 'demo' ? 'Demo mode' : `${a.provider === 'openai' ? 'OpenAI' : 'Anthropic'} · ${a.model}${a.keySource === 'environment' ? ' (key from environment)' : ''}`}`;
      return h('form', { class: 'modal', 'aria-label': 'Settings', onsubmit: async (e) => {
        e.preventDefault(); err.textContent = '';
        try {
          const patch = { provider: draft.provider, openaiModel: draft.openaiModel, anthropicModel: draft.anthropicModel };
          const keys = Object.fromEntries(Object.entries(draft.keys));
          if (Object.keys(keys).length) patch.keys = keys;
          const out = await api('PUT', '/api/settings', patch);
          S.settings = out.settings; S.active = out.active;
          o.close(); renderNotice(); toast('Settings saved');
        } catch (ex) { err.textContent = ex.message; }
      } },
        h('h2', {}, 'Settings'),
        h('p', { class: 'sub' }, 'Choose where replies come from. Keys stay on this computer and are never shown again.'),
        seg, summary, model('openai', 'OpenAI'), keyField('openai', 'OpenAI'), model('anthropic', 'Anthropic'), keyField('anthropic', 'Anthropic'),
        h('div', { class: 'section' },
          h('h3', {}, 'Shared folders'),
          h('p', { class: 'hint' }, 'Agents can look inside these folders. Anything that changes files asks you first, and nothing outside them is ever touched.'),
          folderList,
          h('div', { class: 'folder-add' },
            h('input', { class: 'input', id: 'folder-input', placeholder: 'Absolute path, e.g. /Users/you/Downloads', 'aria-label': 'Folder path' }),
            h('button', { class: 'btn', type: 'button', id: 'folder-add', onclick: () => { const i = $('#folder-input'); const v = i.value.trim(); if (v) setFolders([...S.settings.folders, v]).then(() => { if (!folderErr.textContent) i.value = ''; }); } }, 'Add')),
          folderErr),
        err,
        h('div', { class: 'modal-actions' }, h('span', { class: 'spacer' }), h('button', { class: 'btn', type: 'button', onclick: () => o.close() }, 'Cancel'), h('button', { class: 'btn primary', type: 'submit', id: 'save-settings' }, 'Save')),
      );
    });
  }

  // ---------------------------------------------------------------- global wiring
  document.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 'n') { e.preventDefault(); newChat(); }
    else if (mod && e.key === ',') { e.preventDefault(); openSettings(); }
    else if (e.key === 'Escape' && S.drawerOpen && !$('.modal-back')) { closeDrawer(); }
  });
  document.addEventListener('click', (e) => {
    const a = e.target.closest && e.target.closest('a[href]');
    if (a && /^https?:/.test(a.href)) { e.preventDefault(); window.open(a.href, '_blank', 'noopener,noreferrer'); }
  });
  $('#composer').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('#input');
    const text = input.value.trim();
    if (text && !S.stream) sendMessage(text);
  });

  async function boot() {
    await refreshState();
    const latest = S.chats[0];
    if (latest) {
      const { chat } = await api('GET', `/api/chats/${latest.id}`);
      S.chat = chat; S.agentId = chat.agentId;
    } else S.agentId = S.agents[0].id;
    renderAll();
    scrollDown();
    document.documentElement.dataset.ready = '1';
  }
  boot().catch((err) => {
    document.body.replaceChildren(h('pre', { style: { padding: '24px', whiteSpace: 'pre-wrap' } }, `Muser could not start: ${err.message}`));
  });
})();
