'use strict';
/* global S, W, P, $, $$, h, api, icon, esc, toast, toastErr, debounce, DashTerm, setting, setSetting, renderStatus, currentView, drawCommands, saveUI, TOKEN */

// ---------------------------------------------------------------- sessions
function sessionsOf(pid) {
  return [...S.sessions.values()].filter((s) => s.info.project === pid)
    .sort((a, b) => (a.info.kind === 'terminal') !== (b.info.kind === 'terminal') ? (a.info.kind === 'terminal' ? -1 : 1) : a.order - b.order);
}
let sessOrder = 0;
const pendingOut = new Map();

function upsertSession(info, { resync = false } = {}) {
  let s = S.sessions.get(info.id);
  if (!s) {
    s = { info, model: new DashTerm.TermModel(), order: sessOrder++ };
    S.sessions.set(info.id, s);
    // output that arrived before we knew about this session
    const early = pendingOut.get(info.id);
    pendingOut.delete(info.id);
    if (info.buffer != null) s.model.feed(info.buffer);
    else if (early) early.forEach((d) => s.model.feed(d));
    s.model.flush();
  } else {
    const buf = info.buffer;
    delete info.buffer;
    Object.assign(s.info, info);
    if (resync && buf != null) { s.model.reset(); s.model.feed(buf); s.model.flush(); }
  }
  delete s.info.buffer;
  return s;
}

async function loadSessions(pid, { resync = false } = {}) {
  if (!pid) return;
  let list;
  try { list = await api('run.list', { p: pid }); } catch { return; }
  const ids = new Set(list.map((x) => x.id));
  for (const [id, s] of S.sessions) if (s.info.project === pid && !ids.has(id)) S.sessions.delete(id);
  for (const info of list) upsertSession(info, { resync });
  if (!list.some((x) => x.kind === 'terminal')) {
    try { upsertSession(await api('term.open', { p: pid })); } catch { /* ignore */ }
  }
  const w = S.ws.get(pid);
  if (w && (!w.session || !S.sessions.has(w.session))) {
    const first = sessionsOf(pid)[0];
    w.session = first && first.info.id;
  }
  if (pid === S.pid) { renderSessions(); showSession(W().session); }
}

function currentSession() { const w = W(); return w && S.sessions.get(w.session); }

function showSession(id) {
  const w = W();
  if (!w) return;
  const s = S.sessions.get(id);
  if (!s) return;
  w.session = id;
  const out = $('#term-out');
  if (out.firstChild !== s.model.el) { out.innerHTML = ''; out.appendChild(s.model.el); }
  s.model.flush();
  out.scrollTop = out.scrollHeight;
  renderSessions();
  renderPrompt();
  saveUI();
}

function renderSessions() {
  const box = $('#session-list');
  const w = W();
  box.innerHTML = '';
  if (!w) return;
  for (const s of sessionsOf(S.pid)) {
    const i = s.info;
    const state = i.running ? 'run' : i.code == null ? '' : i.code === 0 ? 'ok' : 'err';
    const row = h('div', { class: 'row' + (w.session === i.id ? ' sel' : ''), title: (i.command || i.name) + '\n' + i.cwd, onclick: (e) => { if (!e.target.closest('.acts')) { showSession(i.id); $('#term-input').focus(); } } },
      h('span', { html: i.kind === 'terminal' ? icon('terminal') : `<span class="dot ${state}"></span>`, style: { width: '16px', display: 'flex', justifyContent: 'center' } }),
      h('span', { class: 'name', text: i.name }),
      h('span', { class: 'acts' },
        i.kind === 'command' ? h('button', { class: 'icon-btn', title: 'Relancer', html: icon('refresh'), onclick: () => restartSession(i.id) }) : null,
        i.running ? h('button', { class: 'icon-btn', title: 'Arrêter (Ctrl+C)', html: icon('stop'), onclick: () => api('run.kill', { id: i.id }).catch(toastErr) }) : null,
        h('button', { class: 'icon-btn', title: 'Fermer', html: icon('close'), onclick: () => closeSession(i.id) })));
    box.appendChild(row);
  }
  const cur = currentSession();
  $('.panel-sub').textContent = cur ? (cur.info.kind === 'command' ? (cur.info.running ? '▶ ' : '') + cur.info.command : '') : '';
  renderPanelActions();
}

function renderPanelActions() {
  const acts = $('.panel-actions');
  const cur = currentSession();
  acts.innerHTML = '';
  const b = (ic, title, fn, show = true) => show && acts.appendChild(h('button', { class: 'icon-btn', title, html: icon(ic), onclick: fn }));
  b('plus', 'Nouveau terminal', newTerminal);
  b('refresh', 'Relancer la commande', () => cur && restartSession(cur.info.id), cur && cur.info.kind === 'command');
  b('stop', 'Arrêter le processus (Ctrl+C)', () => cur && api('run.kill', { id: cur.info.id }).catch(toastErr), cur && cur.info.running);
  b('clear', 'Effacer (Ctrl+L)', clearSession);
  b('copy', 'Copier toute la sortie', () => cur && navigator.clipboard.writeText(cur.model.el.innerText).then(() => toast('Sortie copiée', 'ok', 1200)));
  b(document.body.classList.contains('panel-max') ? 'restore' : 'maximize', 'Agrandir / réduire le panneau', () => { document.body.classList.toggle('panel-max'); renderPanelActions(); });
  b('close', 'Masquer le panneau (Ctrl+`)', () => showPanel(false));
}

// hide what is typed when the process asks for a password (sudo, ssh-keygen, git…)
function maskInput() {
  const cur = currentSession();
  const input = $('#term-input');
  let secret = false;
  if (cur && cur.info.running) {
    const last = cur.model.line.map((x) => x.t).join('');
    secret = /(password|passphrase|mot de passe|passwort|contraseña)[^\n]{0,60}:\s*$/i.test(last);
  }
  const type = secret ? 'password' : 'text';
  if (input.type !== type) input.type = type;
}

function renderPrompt() {
  const cur = currentSession();
  const row = $('#term-input-row');
  const pr = $('#term-prompt');
  const input = $('#term-input');
  maskInput();
  if (!cur) { pr.textContent = ''; return; }
  const i = cur.info;
  const stdin = i.running;
  row.classList.toggle('stdin', stdin);
  if (stdin && i.tty) {
    pr.textContent = 'ssh ›';
    input.placeholder = 'Commande envoyée au serveur (Entrée) — Ctrl+C interrompt, exit pour se déconnecter';
  } else if (stdin) {
    pr.textContent = 'entrée ›';
    input.placeholder = 'Texte envoyé au processus (Entrée) — Ctrl+C pour arrêter';
  } else if (i.kind === 'terminal') {
    const p = P();
    let short = i.cwd;
    if (p && (i.cwd === p.path || i.cwd.startsWith(p.path + S.app.sep))) short = p.name + i.cwd.slice(p.path.length).split(S.app.sep).join('/');
    pr.innerHTML = '<span>' + esc(short) + '</span>';
    pr.title = i.cwd;
    input.placeholder = 'Tapez une commande… (↑ historique, Ctrl+L effacer)';
  } else {
    pr.textContent = i.code === 0 ? '✓' : i.code == null ? '' : '✗ ' + i.code;
    input.placeholder = 'Processus terminé — Entrée pour relancer';
  }
}

async function newTerminal() {
  try {
    const s = upsertSession(await api('term.open', { p: S.pid, new: true }));
    showSession(s.info.id);
    showPanel(true);
  } catch (e) { toastErr(e); }
}

async function restartSession(id) {
  const s = S.sessions.get(id);
  if (!s) return;
  s.model.reset();
  try { await api('run.restart', { id }); } catch (e) { toastErr(e); }
}

async function closeSession(id) {
  const s = S.sessions.get(id);
  if (!s) return;
  if (s.info.running && !(await confirmBox('Fermer la session', `« ${s.info.name} » est en cours d'exécution. L'arrêter et fermer ?`, { ok: 'Arrêter et fermer', danger: true }))) return;
  await api('run.close', { id }).catch(() => {});
  S.sessions.delete(id);
  const w = W();
  if (w.session === id) { const f = sessionsOf(S.pid)[0]; w.session = f && f.info.id; }
  if (!sessionsOf(S.pid).length) await loadSessions(S.pid);
  else { renderSessions(); showSession(w.session); }
  if (currentView === 'commands') drawCommands();
}

function clearSession() {
  const cur = currentSession();
  if (!cur) return;
  cur.model.reset();
  api('run.clear', { id: cur.info.id }).catch(() => {});
}

// run a command (saved, detected or typed) in its own session
async function runCommand(c) {
  if (!S.pid) return;
  try {
    const info = await api('run.start', { p: S.pid, name: c.name || c.command, command: c.command, cwd: c.cwd || '' });
    const s = upsertSession(info);
    if (!info.running && s.info.running) s.info.running = true;
    showPanel(true);
    showSession(info.id);
    if (currentView === 'commands') drawCommands();
  } catch (e) { toastErr(e); }
}

// ---------------------------------------------------------------- terminal input
const hist = { idx: -1, draft: '' };
async function termExec(line, fromApp) {
  let cur = currentSession();
  if (!cur || (fromApp && (cur.info.kind !== 'terminal' || cur.info.running))) {
    const t = sessionsOf(S.pid).find((s) => s.info.kind === 'terminal' && !s.info.running);
    if (t) { showSession(t.info.id); cur = t; }
    else { await newTerminal(); cur = currentSession(); }
  }
  if (!cur) return;
  const i = cur.info;
  if (i.kind === 'command' && !i.running) { restartSession(i.id); return; }
  if (i.kind === 'command') { await api('run.input', { id: i.id, data: line + '\n' }).catch(toastErr); return; }
  if (!i.running) {
    const tl = line.trim();
    if (tl === 'clear' || tl === 'cls') { clearSession(); return; }
    if (tl && !fromApp) {
      const w = W();
      w.termHistory = (w.termHistory || []).filter((x) => x !== tl);
      w.termHistory.push(tl);
      if (w.termHistory.length > 200) w.termHistory.shift();
      saveUI();
    }
  }
  try {
    const r = await api('term.exec', { id: i.id, line });
    if (r && r.cwd) i.cwd = r.cwd;
    renderPrompt();
  } catch (e) { toastErr(e); }
}
window.termExec = termExec;

function setupTerminalInput() {
  const input = $('#term-input');
  input.addEventListener('keydown', (e) => {
    const w = W();
    const mod = e.ctrlKey || e.metaKey;
    if (e.key === 'Enter') {
      e.preventDefault();
      const v = input.value;
      input.value = '';
      hist.idx = -1;
      termExec(v);
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      const list = (w && w.termHistory) || [];
      if (!list.length) return;
      e.preventDefault();
      if (hist.idx === -1) { hist.draft = input.value; hist.idx = list.length; }
      hist.idx += e.key === 'ArrowUp' ? -1 : 1;
      if (hist.idx < 0) hist.idx = 0;
      if (hist.idx >= list.length) { hist.idx = -1; input.value = hist.draft; }
      else input.value = list[hist.idx];
      setTimeout(() => input.setSelectionRange(input.value.length, input.value.length));
    } else if (mod && e.key.toLowerCase() === 'c' && input.selectionStart === input.selectionEnd && !String(getSelection())) {
      const cur = currentSession();
      if (cur && cur.info.running && cur.info.tty) { e.preventDefault(); api('run.input', { id: cur.info.id, data: '\x03' }).catch(toastErr); }
      else if (cur && cur.info.running) { e.preventDefault(); api('run.kill', { id: cur.info.id }).catch(toastErr); }
      else if (input.value) { e.preventDefault(); input.value = ''; }
    } else if (mod && e.key.toLowerCase() === 'l') {
      e.preventDefault();
      clearSession();
    } else if (e.key === 'Tab') {
      e.preventDefault();
      completePath(input);
    }
  });
  $('#term-out').addEventListener('mouseup', () => { if (!String(getSelection())) input.focus(); });
}

// file name completion relative to the terminal folder (inside the project)
async function completePath(input) {
  const cur = currentSession();
  const p = P();
  if (!cur || !p) return;
  const v = input.value.slice(0, input.selectionStart);
  const m = v.match(/(\S*)$/);
  const word = m[1].replace(/^["']/, '');
  let base = cur.info.cwd;
  if (!(base === p.path || base.startsWith(p.path + S.app.sep))) return;
  const relCwd = base.slice(p.path.length).split(S.app.sep).filter(Boolean).join('/');
  const dir = word.includes('/') ? word.slice(0, word.lastIndexOf('/') + 1) : '';
  const prefix = word.slice(dir.length);
  let list;
  try { list = await api('fs.list', { p: p.id, path: joinPath(relCwd, dir) }); } catch { return; }
  const hits = list.filter((e) => e.name.startsWith(prefix));
  if (!hits.length) return;
  let common = hits[0].name;
  for (const x of hits) while (!x.name.startsWith(common)) common = common.slice(0, -1);
  if (hits.length === 1 && hits[0].dir) common += '/';
  const add = common.slice(prefix.length);
  if (add) {
    input.setRangeText(add, input.selectionStart, input.selectionStart, 'end');
  } else if (hits.length > 1) {
    cur.model.feed('\x1b[90m' + hits.map((x) => x.name + (x.dir ? '/' : '')).join('  ') + '\x1b[0m\r\n');
    cur.model.flush();
  }
}

// ---------------------------------------------------------------- panel visibility
function showPanel(show, { focus = true } = {}) {
  if (show === undefined) show = document.body.classList.contains('no-panel');
  document.body.classList.toggle('no-panel', !show);
  if (!show) document.body.classList.remove('panel-max');
  setSetting('panelOpen', show);
  if (show) {
    const out = $('#term-out');
    out.scrollTop = out.scrollHeight;
    if (focus) $('#term-input').focus();
  } else {
    const ta = document.querySelector('textarea.editor');
    ta && ta.offsetParent && ta.focus();
  }
}

// ---------------------------------------------------------------- events (SSE)
const flushQueue = new Set();
let flushScheduled = false;
function scheduleFlush(s) {
  flushQueue.add(s);
  if (flushScheduled) return;
  flushScheduled = true;
  requestAnimationFrame(() => {
    flushScheduled = false;
    const out = $('#term-out');
    const atBottom = out.scrollHeight - out.scrollTop - out.clientHeight < 40;
    for (const x of flushQueue) x.model.flush();
    maskInput();
    flushQueue.clear();
    if (atBottom) out.scrollTop = out.scrollHeight;
  });
}

function connectEvents() {
  let wasDown = false;
  const es = new EventSource('/api/events?t=' + TOKEN);
  es.onopen = () => {
    S.connected = true;
    renderStatus();
    if (wasDown) { wasDown = false; loadSessions(S.pid, { resync: true }); }
  };
  es.onerror = () => { S.connected = false; wasDown = true; renderStatus(); };
  es.onmessage = (ev) => {
    let m;
    try { m = JSON.parse(ev.data); } catch { return; }
    const s = m.id && S.sessions.get(m.id);
    switch (m.t) {
      case 'out':
        if (s) { s.model.feed(m.d); scheduleFlush(s); }
        else {
          const q = pendingOut.get(m.id) || [];
          if (q.length < 500) q.push(m.d);
          pendingOut.set(m.id, q);
        }
        break;
      case 'clear':
        if (s) { s.model.reset(); }
        break;
      case 'status':
        if (!s) { loadSessions(S.pid); break; }
        s.info.running = m.running;
        if (!m.running) {
          s.info.code = m.code;
          if (s.info.kind === 'command' && s.info.project === S.pid) {
            const hidden = document.body.classList.contains('no-panel') || W().session !== s.info.id;
            if (hidden || document.visibilityState !== 'visible') toast(`${s.info.name} : ${m.code === 0 ? 'terminé ✓' : 'échec (code ' + m.code + ')'}`, m.code === 0 ? 'ok' : 'err', 5000);
            if (s.info.name.toLowerCase().includes('git') || /\bgit\b/.test(s.info.command)) refreshGitSoon();
          }
          if (s.info.kind === 'terminal') { refreshGitSoon(); }
        }
        if (s.info.project === S.pid) { renderSessions(); renderPrompt(); renderStatus(); if (currentView === 'commands') drawCommands(); if (currentView === 'ssh') window.SSHView.drawSsh(); }
        break;
      case 'cwd':
        if (s) { s.info.cwd = m.cwd; if (s === currentSession()) renderPrompt(); }
        break;
      case 'update':
        handleUpdate(m);
        break;
      case 'askpass':
        window.SSHView.onAskpass(m);
        break;
      case 'askpass-done':
        window.SSHView.onAskpassDone(m);
        break;
      case 'sessions':
        if (m.p === S.pid) loadSessions(S.pid);
        break;
    }
  };
}
