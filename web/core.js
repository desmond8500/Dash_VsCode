'use strict';
/* global DashMD, DashTerm */
// ---------------------------------------------------------------- basics
const TOKEN = document.querySelector('meta[name=dash-token]').content;
const VERSION = document.querySelector('meta[name=dash-version]').content;
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const esc = DashMD.esc;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'html') el.innerHTML = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.appendChild(typeof kid === 'string' ? document.createTextNode(kid) : kid);
  }
  return el;
}

function debounce(fn, ms) {
  let t;
  const d = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  d.flush = (...a) => { clearTimeout(t); fn(...a); };
  return d;
}

async function api(name, body) {
  let r;
  try {
    r = await fetch('/api/' + name, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Dash-Token': TOKEN },
      body: JSON.stringify(body || {}),
    });
  } catch (e) {
    const err = new Error("Dash Lite ne répond plus. L'application a peut-être été fermée.");
    err.status = 0;
    throw err;
  }
  let data = null;
  try { data = await r.json(); } catch { data = {}; }
  if (!r.ok) {
    const e = new Error((data && data.error) || 'Erreur HTTP ' + r.status);
    e.status = r.status;
    throw e;
  }
  return data;
}

const rawUrl = (pid, path) => `/api/raw?p=${encodeURIComponent(pid)}&path=${encodeURIComponent(path)}&t=${TOKEN}`;

// path helpers (project paths always use "/")
const basename = (p) => p.split('/').filter(Boolean).pop() || p;
const dirname = (p) => { const i = p.lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i); };
const joinPath = (...parts) => normPath(parts.filter((x) => x !== '' && x != null).join('/'));
function normPath(p) {
  const out = [];
  for (const seg of p.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') out.pop(); else out.push(seg);
  }
  return out.join('/');
}
const extOf = (p) => { const b = basename(p); const i = b.lastIndexOf('.'); return i > 0 ? b.slice(i + 1).toLowerCase() : b.toLowerCase(); };
const isMd = (p) => ['md', 'markdown', 'mdx', 'mdown'].includes(extOf(p));
const isImage = (p) => ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif'].includes(extOf(p));

// ---------------------------------------------------------------- icons
const ICONS = {
  files: '<path d="M6 3.5v-1a1 1 0 0 1 1-1h4.5L14 4v8a1 1 0 0 1-1 1h-1"/><path d="M2 5a1 1 0 0 1 1-1h5l3 3v6.5a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z"/>',
  search: '<circle cx="9.5" cy="6.5" r="4"/><path d="M6.6 9.4 2 14"/>',
  git: '<circle cx="4.5" cy="3.5" r="1.5"/><circle cx="4.5" cy="12.5" r="1.5"/><circle cx="11.5" cy="5.5" r="1.5"/><path d="M4.5 5v6M11.5 7c0 3-7 1.5-7 4"/>',
  tasks: '<path d="M1.8 3.6 3 4.8l2.2-2.3M1.8 8.1 3 9.3l2.2-2.3M1.8 12.6 3 13.8l2.2-2.3"/><path d="M8 3.8h6.2M8 8.3h6.2M8 12.8h6.2"/>',
  commands: '<rect x="1.5" y="2.5" width="13" height="11" rx="1.2"/><path d="m4.2 6 2.4 2-2.4 2M8.3 10.3h3.5"/>',
  projects: '<path d="M8 1.5 1.5 5 8 8.5 14.5 5z"/><path d="M1.5 8 8 11.5 14.5 8M1.5 11 8 14.5 14.5 11"/>',
  gear: '<circle cx="8" cy="8" r="2.2"/><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4"/>',
  menu: '<path d="M2.5 4h11M2.5 8h11M2.5 12h11"/>',
  right: '<path d="m6 4 4 4-4 4"/>',
  down: '<path d="m4 6 4 4 4-4"/>',
  up: '<path d="m4 10 4-4 4 4"/>',
  close: '<path d="m4 4 8 8M12 4l-8 8"/>',
  plus: '<path d="M8 3v10M3 8h10"/>',
  minus: '<path d="M3 8h10"/>',
  refresh: '<path d="M13 2.5V6H9.5"/><path d="M12.7 6A5 5 0 1 0 13 9"/>',
  sync: '<path d="M2.5 7a5.5 5.5 0 0 1 10-2.6M13.5 9a5.5 5.5 0 0 1-10 2.6"/><path d="M12.8 1.6v3h-3M3.2 14.4v-3h3"/>',
  newfile: '<path d="M8.5 14.5H4a1 1 0 0 1-1-1v-11a1 1 0 0 1 1-1h5l4 4V8"/><path d="M9 1.5v4h4M12 10v5M9.5 12.5h5"/>',
  newfolder: '<path d="M8 13.5H2.5a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1H6l1.5 2h6a1 1 0 0 1 1 1V8"/><path d="M12 10v5M9.5 12.5h5"/>',
  collapse: '<rect x="2.5" y="2.5" width="11" height="11" rx="1.2"/><path d="M5.5 8h5"/>',
  play: '<path d="M5 3.3v9.4L12.3 8z"/>',
  stop: '<rect x="4" y="4" width="8" height="8" rx="1"/>',
  trash: '<path d="M2.5 4h11M6 4V2.5h4V4M4 4l.7 9.5h6.6L12 4"/>',
  edit: '<path d="m11 2.5 2.5 2.5-8 8H3v-2.5z"/>',
  star: '<path d="m8 1.8 1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.6l-3.8 2 .7-4.3-3.1-3 4.3-.6z"/>',
  discard: '<path d="M4 6h6.5a3 3 0 0 1 0 6H7"/><path d="M6.5 3.5 4 6l2.5 2.5"/>',
  arrowUp: '<path d="M8 13V3M4 7l4-4 4 4"/>',
  arrowDown: '<path d="M8 3v10M4 9l4 4 4-4"/>',
  pull: '<path d="M8 1.5v9M4.5 7 8 10.5 11.5 7M3 14h10"/>',
  push: '<path d="M8 14V5M4.5 8.5 8 5l3.5 3.5M3 2h10"/>',
  check: '<path d="m3 8.5 3 3 7-7"/>',
  terminal: '<path d="m2.5 4 4 4-4 4M8 12.5h5.5"/>',
  clear: '<circle cx="8" cy="8" r="5.5"/><path d="m4.1 11.9 7.8-7.8"/>',
  split: '<rect x="1.5" y="2.5" width="13" height="11" rx="1.2"/><path d="M8 2.5v11"/>',
  eye: '<path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/>',
  folder: '<path d="M1.5 4.5v8a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1v-6a1 1 0 0 0-1-1H7.5L6 3.5H2.5a1 1 0 0 0-1 1z"/>',
  folderOpen: '<path d="M1.5 12.5v-8a1 1 0 0 1 1-1H6l1.5 2h5a1 1 0 0 1 1 1v1"/><path d="M1.5 12.5 3.3 8a1 1 0 0 1 .9-.6h10a.6.6 0 0 1 .6.8l-1.6 4.4a1 1 0 0 1-.9.6H2.5a1 1 0 0 1-1-1z"/>',
  file: '<path d="M9.5 1.5H4a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V5z"/><path d="M9.5 1.5V5H13"/>',
  link: '<path d="m6.5 9.5 3-3M7 4.5l1-1a2.5 2.5 0 0 1 3.5 3.5l-1 1M9 11.5l-1 1A2.5 2.5 0 0 1 4.5 9l1-1"/>',
  history: '<circle cx="8" cy="8" r="6"/><path d="M8 4.5V8l2.5 1.5"/>',
  more: '<circle cx="3.5" cy="8" r=".8"/><circle cx="8" cy="8" r=".8"/><circle cx="12.5" cy="8" r=".8"/>',
  copy: '<rect x="5.5" y="5.5" width="8" height="8" rx="1"/><path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2"/>',
  wrap: '<path d="M2.5 4h11M2.5 8h9a2 2 0 0 1 0 4H8M9.5 10.5 8 12l1.5 1.5M2.5 12h3"/>',
  filter: '<path d="M2 3.5h12L9.5 9v4l-3 1.5V9z"/>',
  maximize: '<path d="m4 10 4-4 4 4"/>',
  restore: '<path d="m4 6 4 4 4-4"/>',
  fetch: '<path d="M2.5 8a5.5 5.5 0 1 0 1.6-3.9"/><path d="M2.5 2v3h3"/><path d="M8 5v3.5l2 1.2"/>',
  bell: '<path d="M4 11V7a4 4 0 0 1 8 0v4l1 1.5H3zM6.5 14h3"/>',
  power: '<path d="M8 2v6M4.6 4a5 5 0 1 0 6.8 0"/>',
  logo: '<path d="M3 2.5h4.5a5.5 5.5 0 0 1 0 11H3z"/><path d="m6 6 2 2-2 2"/>',
  info: '<circle cx="8" cy="8" r="6"/><path d="M8 7.2v4M8 4.8v.1"/>',
  key: '<rect x="1.5" y="4.5" width="13" height="7" rx="1"/><path d="M4 7h1M7 7h1M10 7h2M4 9h8"/>',
  branch: '<circle cx="4.5" cy="3.5" r="1.5"/><circle cx="4.5" cy="12.5" r="1.5"/><circle cx="11.5" cy="5.5" r="1.5"/><path d="M4.5 5v6M11.5 7c0 3-7 1.5-7 4"/>',
  box: '<rect x="2.5" y="2.5" width="11" height="11" rx="1.5"/>',
  outline: '<path d="M2.5 3.5h11M5 6.5h8.5M5 9.5h8.5M7.5 12.5h6"/><circle cx="2.8" cy="12.5" r=".1"/>',
  checkbox: '<rect x="2.5" y="2.5" width="11" height="11" rx="1.5"/><path d="m5 8 2 2 4-4"/>',
};
function icon(name, cls) {
  return `<svg class="i${cls ? ' ' + cls : ''}" viewBox="0 0 16 16" aria-hidden="true">${ICONS[name] || ''}</svg>`;
}
const FILE_COLORS = {
  md: '#519aba', markdown: '#519aba', mdx: '#519aba', txt: '#a0a0a0', js: '#cbcb41', mjs: '#cbcb41', cjs: '#cbcb41', jsx: '#5fb8ff', ts: '#3d8fd1', tsx: '#5fb8ff',
  json: '#cbcb41', php: '#a074c4', py: '#ffcf3f', go: '#29beb0', rs: '#dea584', java: '#e76f00', kt: '#a97bff', cs: '#68217a', html: '#e37933', htm: '#e37933',
  css: '#42a5f5', scss: '#f55385', less: '#42a5f5', vue: '#8dc149', svelte: '#ff3e00', dart: '#40c4ff', rb: '#cc3e44', sh: '#89e051', bash: '#89e051', zsh: '#89e051',
  ps1: '#3e7ac6', bat: '#c1f12e', cmd: '#c1f12e', yml: '#cb4b4b', yaml: '#cb4b4b', toml: '#9c4221', xml: '#e37933', svg: '#ffb13b', png: '#a074c4', jpg: '#a074c4',
  jpeg: '#a074c4', gif: '#a074c4', webp: '#a074c4', ico: '#a074c4', sql: '#f55385', env: '#e5c07b', lock: '#7f7f7f', gitignore: '#e05d44', dockerfile: '#2496ed',
  makefile: '#e05d44', c: '#5c8dbc', h: '#a074c4', cpp: '#5c8dbc', swift: '#f05138', blade: '#f05340', ini: '#9c9c9c', log: '#7f7f7f', pdf: '#e04e39', zip: '#c8a800',
};
function fileIcon(name, dir, open) {
  if (dir) return `<span class="ficon" style="color:#c09553">${icon(open ? 'folderOpen' : 'folder')}</span>`;
  let ext = extOf(name);
  if (name.toLowerCase().endsWith('.blade.php')) ext = 'blade';
  if (name.startsWith('.env')) ext = 'env';
  const c = FILE_COLORS[ext] || '#8a8a8a';
  return `<span class="ficon" style="color:${c}">${icon('file')}</span>`;
}

// ---------------------------------------------------------------- state
const S = {
  app: null,
  projects: [],
  pid: null,
  settings: {},
  ws: new Map(),
  sessions: new Map(), // id -> {info, model}
  connected: false,
};
const W = () => S.ws.get(S.pid);
const P = () => S.projects.find((p) => p.id === S.pid);
function setting(k, def) { return S.settings[k] === undefined ? def : S.settings[k]; }
const saveSettings = debounce((patch) => api('settings.set', patch).catch(() => {}), 300);
function setSetting(k, v) {
  S.settings[k] = v;
  pendingSettings[k] = v;
  saveSettings({ ...pendingSettings });
}
const pendingSettings = {};

// ---------------------------------------------------------------- toasts
function toast(msg, kind = '', ms = 4000) {
  const t = h('div', { class: 'toast ' + kind }, h('div', { style: { flex: 1 } }, msg), h('button', { class: 'x', html: icon('close'), onclick: () => t.remove() }));
  $('#toasts').appendChild(t);
  if (ms) setTimeout(() => t.remove(), ms);
  return t;
}
const toastErr = (e) => toast(e && e.message ? e.message : String(e), 'err', 7000);

// ---------------------------------------------------------------- modal
function modal({ title, body, buttons = [], wide = false, onOpen, dismiss = true }) {
  return new Promise((resolve) => {
    const back = h('div', { class: 'modal-back' });
    const box = h('div', { class: 'modal' + (wide ? ' wide' : '') });
    const close = (v) => { back.remove(); document.removeEventListener('keydown', onKey, true); resolve(v); };
    const head = h('div', { class: 'modal-head' }, h('span', { class: 'grow', text: title }), h('button', { class: 'icon-btn', html: icon('close'), onclick: () => close(null) }));
    const bodyEl = h('div', { class: 'modal-body' });
    if (typeof body === 'string') bodyEl.innerHTML = body; else if (body) bodyEl.appendChild(body);
    const foot = h('div', { class: 'modal-foot' });
    for (const b of buttons) {
      foot.appendChild(h('button', {
        class: 'btn' + (b.kind ? ' ' + b.kind : ''),
        text: b.label,
        onclick: async () => {
          if (b.validate) { const ok = await b.validate(bodyEl); if (!ok) return; }
          close(typeof b.value === 'function' ? b.value(bodyEl) : b.value);
        },
      }));
    }
    box.append(head, bodyEl);
    if (buttons.length) box.appendChild(foot);
    back.appendChild(box);
    if (dismiss) back.addEventListener('mousedown', (e) => { if (e.target === back) close(null); });
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(null); }
      if (e.key === 'Enter' && !e.shiftKey && e.target.tagName !== 'TEXTAREA' && !e.target.closest('.picker-list, [data-noenter]')) {
        const primary = buttons.find((b) => b.primary);
        if (primary) {
          e.preventDefault();
          const btn = $$('.btn', foot)[buttons.indexOf(primary)];
          btn && btn.click();
        }
      }
    };
    document.addEventListener('keydown', onKey, true);
    $('#modal-root').appendChild(back);
    box.close = close;
    if (onOpen) onOpen(bodyEl, close);
    const first = $('input:not([type=checkbox]), textarea, select', bodyEl);
    if (first) { first.focus(); if (first.select) first.select(); }
    else { const pb = $('.btn', foot); pb && pb.focus(); }
  });
}

function prompt(title, { value = '', placeholder = '', label = '', hint = '', ok = 'OK', select } = {}) {
  const body = h('div', null,
    label ? h('div', { class: 'field' }, h('label', { text: label })) : null,
    h('input', { class: 'input', value, placeholder, spellcheck: 'false' }),
    hint ? h('div', { class: 'field' }, h('div', { class: 'hint', text: hint })) : null);
  return modal({
    title, body,
    buttons: [{ label: 'Annuler', kind: 'secondary', value: null }, { label: ok, primary: true, value: (b) => $('input', b).value }],
    onOpen: (b) => {
      const inp = $('input', b);
      setTimeout(() => {
        inp.focus();
        if (select) inp.setSelectionRange(select[0], select[1]); else inp.select();
      });
    },
  });
}

function confirmBox(title, message, { ok = 'OK', danger = false, cancel = 'Annuler' } = {}) {
  return modal({
    title,
    body: h('p', { text: message }),
    buttons: [{ label: cancel, kind: 'secondary', value: false }, { label: ok, kind: danger ? 'danger' : '', primary: true, value: true }],
  }).then((v) => !!v);
}

function showOutput(title, output, ok) {
  return modal({
    title,
    wide: true,
    body: h('div', null, h('pre', { class: 'output', text: output || (ok ? 'Terminé.' : 'Échec.') })),
    buttons: [{ label: 'Fermer', primary: true, value: true }],
  });
}

// ---------------------------------------------------------------- context menu
function ctxMenu(x, y, items) {
  const m = $('#ctxmenu');
  m.innerHTML = '';
  for (const it of items) {
    if (!it) continue;
    if (it === '-') { m.appendChild(h('div', { class: 'ms' })); continue; }
    m.appendChild(h('div', {
      class: 'mi' + (it.danger ? ' danger' : ''),
      onmousedown: (e) => e.preventDefault(),
      onclick: () => { hideCtx(); it.action(); },
    }, h('span', { text: it.label }), it.kb ? h('span', { class: 'kb', text: it.kb }) : null));
  }
  m.hidden = false;
  const r = m.getBoundingClientRect();
  m.style.left = Math.min(x, innerWidth - r.width - 4) + 'px';
  m.style.top = Math.min(y, innerHeight - r.height - 4) + 'px';
}
function hideCtx() { $('#ctxmenu').hidden = true; }
document.addEventListener('mousedown', (e) => { if (!e.target.closest('#ctxmenu')) hideCtx(); });
window.addEventListener('blur', hideCtx);

// ---------------------------------------------------------------- fuzzy
function fuzzy(q, s) {
  if (!q) return { score: 0, idx: [] };
  const ql = q.toLowerCase();
  const sl = s.toLowerCase();
  let qi = 0, score = 0, last = -2;
  const idx = [];
  for (let i = 0; i < sl.length && qi < ql.length; i++) {
    if (sl[i] === ql[qi]) {
      let sc = 1;
      if (i === last + 1) sc += 5;
      if (i === 0 || /[\/\\._\-\s]/.test(s[i - 1])) sc += 4;
      if (s[i] !== sl[i] && s[i - 1] && s[i - 1] === s[i - 1].toLowerCase()) sc += 2;
      score += sc;
      idx.push(i);
      last = i;
      qi++;
    }
  }
  if (qi < ql.length) return null;
  return { score: score - sl.length * 0.02, idx };
}
function matchPath(q, path) {
  const q2 = q.replace(/\s+/g, '');
  const base = basename(path);
  const off = path.length - base.length;
  const fb = fuzzy(q2, base);
  if (fb) return { score: fb.score * 2 + 10, idx: fb.idx.map((i) => i + off) };
  return fuzzy(q2, path);
}
function hl(text, idx) {
  if (!idx || !idx.length) return esc(text);
  const set = new Set(idx);
  let out = '';
  for (let i = 0; i < text.length; i++) out += set.has(i) ? '<b>' + esc(text[i]) + '</b>' : esc(text[i]);
  return out.replace(/<\/b><b>/g, '');
}

// ---------------------------------------------------------------- quick pick
// items: [{label, desc, kb, icon, sep, run, filter}]
const QP = { open: false };
function quickPick({ placeholder = '', items = [], value = '', source, onAccept, matcher }) {
  return new Promise((resolve) => {
    const root = $('#quickpick');
    const input = $('.qp-input', root);
    const list = $('.qp-list', root);
    let shown = [];
    let active = 0;
    let done = false;
    let seq = 0;
    const finish = (v) => {
      if (done) return;
      done = true;
      root.hidden = true;
      QP.open = false;
      input.oninput = input.onkeydown = null;
      root.onmousedown = null;
      resolve(v);
      if (v && v.run) v.run(v);
      else if (v && onAccept) onAccept(v);
    };
    const render = async () => {
      const my = ++seq;
      const q = input.value;
      let src = items;
      if (source) {
        const r = source(q);
        src = r && r.then ? await r : r;
        if (my !== seq || done) return;
        if (src && src.redirect) { finish(null); src.redirect(); return; }
      }
      const fq = source && source.query ? source.query(q) : q;
      let res;
      if (!fq) res = src.map((it) => ({ it, m: null }));
      else {
        res = [];
        for (const it of src) {
          if (it.sep) continue;
          const m = matcher ? matcher(fq, it) : fuzzy(fq, it.filter || it.label);
          if (m) res.push({ it, m });
        }
        res.sort((a, b) => b.m.score - a.m.score);
      }
      shown = res.slice(0, 300);
      active = Math.min(active, Math.max(0, shown.length - 1));
      while (shown[active] && shown[active].it.sep) active++;
      list.innerHTML = '';
      if (!shown.filter((x) => !x.it.sep).length) {
        list.appendChild(h('div', { class: 'qp-empty', text: src.emptyText || 'Aucun résultat' }));
        return;
      }
      shown.forEach(({ it, m }, i) => {
        if (it.sep) { list.appendChild(h('div', { class: 'qp-sep', text: it.label })); return; }
        const labelIdx = m && !it.filter ? m.idx : m && it.labelIdx ? it.labelIdx(m) : null;
        const el = h('div', { class: 'qp-item' + (i === active ? ' active' : ''), 'data-i': i },
          it.icon ? h('span', { html: it.icon, class: 'ficon' }) : null,
          h('span', { class: 'lbl', html: hl(it.label, labelIdx) }),
          it.desc ? h('span', { class: 'dsc', text: it.desc }) : h('span', { class: 'dsc' }),
          it.kb ? h('span', { class: 'kb', text: it.kb }) : null);
        el.addEventListener('mousemove', () => { if (active !== i) { active = i; mark(); } });
        el.addEventListener('click', () => finish(it));
        list.appendChild(el);
      });
    };
    const mark = () => {
      $$('.qp-item', list).forEach((el) => el.classList.toggle('active', +el.dataset.i === active));
      const a = $('.qp-item.active', list);
      a && a.scrollIntoView({ block: 'nearest' });
    };
    const move = (d) => {
      if (!shown.length) return;
      let n = active;
      for (let k = 0; k < shown.length; k++) {
        n = (n + d + shown.length) % shown.length;
        if (!shown[n].it.sep) break;
      }
      active = n;
      mark();
    };
    input.value = value;
    input.placeholder = placeholder;
    root.hidden = false;
    QP.open = true;
    QP.close = () => finish(null);
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
    let pending = null;
    input.oninput = () => { active = 0; pending = render(); };
    input.onkeydown = (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
      else if (e.key === 'PageDown') { e.preventDefault(); move(10); }
      else if (e.key === 'PageUp') { e.preventDefault(); move(-10); }
      else if (e.key === 'Enter') {
        e.preventDefault();
        // results may still be loading when typing fast
        Promise.resolve(pending).then(() => { const s = shown[active]; if (s && !s.it.sep) finish(s.it); });
      }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(null); }
    };
    root.onmousedown = (e) => { if (e.target === root) finish(null); };
    pending = render();
  });
}

// ---------------------------------------------------------------- misc
function relTime(ms) {
  const d = (Date.now() - ms) / 1000;
  if (d < 60) return "à l'instant";
  if (d < 3600) return `il y a ${Math.floor(d / 60)} min`;
  if (d < 86400) return `il y a ${Math.floor(d / 3600)} h`;
  return new Date(ms).toLocaleDateString();
}
function copyText(t) {
  navigator.clipboard.writeText(t).then(() => toast('Copié dans le presse-papiers', 'ok', 1500), () => toast('Copie impossible', 'err'));
}
const LANGS = {
  md: 'Markdown', markdown: 'Markdown', js: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript', ts: 'TypeScript', tsx: 'TypeScript React', jsx: 'JavaScript React',
  json: 'JSON', php: 'PHP', py: 'Python', go: 'Go', rs: 'Rust', java: 'Java', kt: 'Kotlin', cs: 'C#', html: 'HTML', css: 'CSS', scss: 'SCSS', vue: 'Vue',
  dart: 'Dart', rb: 'Ruby', sh: 'Shell', bash: 'Shell', ps1: 'PowerShell', bat: 'Batch', yml: 'YAML', yaml: 'YAML', toml: 'TOML', xml: 'XML', sql: 'SQL',
  txt: 'Texte brut', c: 'C', cpp: 'C++', h: 'C', swift: 'Swift', svelte: 'Svelte', ini: 'Ini', env: 'Dotenv',
};
const langOf = (p) => LANGS[extOf(p)] || (basename(p).toLowerCase() === 'makefile' ? 'Makefile' : basename(p).toLowerCase() === 'dockerfile' ? 'Dockerfile' : 'Texte brut');
const IS_MAC = /Mac/.test(navigator.platform);
const MOD = IS_MAC ? '⌘' : 'Ctrl';
