'use strict';
/* global S, W, P, $, $$, h, api, icon, fileIcon, esc, toast, toastErr, modal, confirmBox, ctxMenu, debounce, basename, dirname, joinPath, normPath, isMd, isImage, rawUrl, setting, setSetting, DashMD, langOf, copyText, saveUI, refreshGitSoon, refreshTasksSoon, revealInExplorer, renderStatus, renderExplorer, MOD */

// ---------------------------------------------------------------- tabs model
function tabKey(t) { return t.key || t.path; }
function activeTab() { const w = W(); return w && w.tabs.find((t) => tabKey(t) === w.active); }
function isDirty(t) { return t.kind === 'text' && t.loaded && t.content !== t.saved; }
function findTab(path, pid = S.pid) {
  const w = S.ws.get(pid);
  return w && w.tabs.find((t) => !t.key && t.path === path);
}

async function loadTab(t) {
  if (t.loaded || t.loading) return t.loading;
  t.loading = (async () => {
    if (isImage(t.path)) { t.kind = 'image'; t.loaded = true; return; }
    try {
      const r = await api('fs.read', { p: t.pid, path: t.path });
      t.mtime = r.mtime;
      t.size = r.size;
      if (r.binary) t.kind = 'binary';
      else if (r.tooLarge) t.kind = 'large';
      else {
        t.kind = 'text';
        t.content = t.saved = r.content;
        t.eol = r.eol || 'lf';
        t.bom = !!r.bom;
        t.encoding = r.encoding || 'utf8';
        t.indent = detectIndent(r.content, t.path);
      }
    } catch (e) {
      t.kind = 'missing';
      t.error = e.message;
    }
    t.loaded = true;
  })();
  await t.loading;
  t.loading = null;
}

function detectIndent(text, path) {
  let tabs = 0, spaces = 0;
  const counts = {};
  const lines = text.split('\n', 2000);
  for (const l of lines) {
    if (l.startsWith('\t')) tabs++;
    else {
      const m = l.match(/^( +)\S/);
      if (m) { spaces++; const n = m[1].length; if (n <= 8) counts[n] = (counts[n] || 0) + 1; }
    }
  }
  if (tabs > spaces) return '\t';
  const def = isMd(path) || /\.(ya?ml|json|js|ts|vue|jsx|tsx|css|scss|html|dart|rb)$/i.test(path) ? 2 : setting('indent', 4);
  if (!spaces) return ' '.repeat(def);
  if ((counts[2] || 0) >= (counts[4] || 0) * 0.5 && counts[2]) return '  ';
  if (counts[4]) return '    ';
  return ' '.repeat(def);
}

async function openFile(path, opts = {}) {
  const w = W();
  if (!w) return;
  path = normPath(path);
  let t = findTab(path);
  const preview = opts.preview !== false && setting('previewTabs', true);
  if (!t) {
    t = { pid: S.pid, path, name: basename(path), preview, loaded: false };
    const prevIdx = w.tabs.findIndex((x) => x.preview && !isDirty(x) && !x.key);
    const curIdx = w.tabs.findIndex((x) => tabKey(x) === w.active);
    if (preview && prevIdx >= 0) w.tabs.splice(prevIdx, 1, t);
    else w.tabs.splice(curIdx >= 0 ? curIdx + 1 : w.tabs.length, 0, t);
    if (isMd(path)) t.mode = w.mdModes[path] || setting('mdMode', 'edit');
  } else if (!preview) t.preview = false;
  w.active = path;
  renderTabs();
  await loadTab(t);
  if (W() !== w || w.active !== path) return t;
  renderEditor();
  if (opts.line) revealLine(t, opts.line, opts.col, opts.len);
  else if (opts.focus !== false && t.kind === 'text' && t.mode !== 'preview') ED.ta.focus();
  if (opts.reveal !== false) revealInExplorer && revealInExplorer(path);
  saveUI();
  return t;
}

function openVirtual(key, name, kind, data) {
  const w = W();
  let t = w.tabs.find((x) => x.key === key);
  if (!t) {
    t = { pid: S.pid, key, path: data.path || '', name, kind, loaded: true, ...data };
    const curIdx = w.tabs.findIndex((x) => tabKey(x) === w.active);
    w.tabs.splice(curIdx >= 0 ? curIdx + 1 : w.tabs.length, 0, t);
  } else Object.assign(t, data);
  w.active = key;
  renderTabs();
  renderEditor();
}

async function activateTab(key) {
  const w = W();
  storeEditorState();
  w.active = key;
  const t = activeTab();
  renderTabs();
  if (t && !t.loaded) await loadTab(t);
  if (W() !== w || w.active !== key) return;
  renderEditor();
  if (t && t.kind === 'text' && t.mode !== 'preview') ED.ta.focus();
  if (t && !t.key) revealInExplorer(t.path);
  saveUI();
}

async function closeTab(t, { force = false } = {}) {
  const w = S.ws.get(t.pid);
  if (!w) return true;
  if (!force && isDirty(t)) {
    const v = await modal({
      title: 'Enregistrer les modifications ?',
      body: h('p', { text: `Voulez-vous enregistrer les modifications apportées à ${t.name} ? Elles seront perdues sinon.` }),
      buttons: [
        { label: 'Annuler', kind: 'secondary', value: null },
        { label: 'Ne pas enregistrer', kind: 'secondary', value: 'discard' },
        { label: 'Enregistrer', primary: true, value: 'save' },
      ],
    });
    if (!v) return false;
    if (v === 'save' && !(await saveTab(t))) return false;
  }
  const i = w.tabs.indexOf(t);
  if (i < 0) return true;
  if (tabKey(t) === w.active) storeEditorState();
  w.tabs.splice(i, 1);
  if (w.active === tabKey(t)) {
    const next = w.tabs[i] || w.tabs[i - 1];
    w.active = next ? tabKey(next) : null;
    if (next && !next.loaded) await loadTab(next);
  }
  if (t.pid === S.pid) { renderTabs(); renderEditor(); }
  saveUI();
  return true;
}

async function closeTabs(list) {
  for (const t of list.slice()) { if (!(await closeTab(t))) return false; }
  return true;
}

async function saveTab(t, { force = false } = {}) {
  if (!t || t.kind !== 'text' || !t.loaded) return true;
  const content = t.content;
  try {
    const r = await api('fs.write', { p: t.pid, path: t.path, content, mtime: force ? 0 : t.mtime, force, eol: t.eol, bom: t.bom, encoding: t.encoding });
    t.saved = content;
    t.mtime = r.mtime;
    t.conflict = null;
    t.preview = false;
    if (t.pid === S.pid) { renderTabs(); if (activeTab() === t) renderBanner(); }
    refreshGitSoon();
    if (isMd(t.path)) refreshTasksSoon();
    return true;
  } catch (e) {
    if (e.status === 409) {
      t.conflict = 'changed';
      if (activeTab() === t) renderBanner();
      toast(`${t.name} a été modifié sur le disque. Choisissez de recharger ou d'écraser.`, 'err', 6000);
    } else toastErr(e);
    return false;
  }
}

async function saveAll() {
  const w = W();
  if (!w) return;
  let n = 0;
  for (const t of w.tabs) if (isDirty(t) && (await saveTab(t))) n++;
  if (n) toast(`${n} fichier(s) enregistré(s)`, 'ok', 1500);
}

async function reloadTab(t, keepView = true) {
  const sel = activeTab() === t ? [ED.ta.selectionStart, ED.ta.selectionEnd, ED.ta.scrollTop] : null;
  t.loaded = false;
  t.conflict = null;
  await loadTab(t);
  if (activeTab() === t) {
    renderEditor();
    if (keepView && sel && t.kind === 'text') {
      ED.ta.setSelectionRange(Math.min(sel[0], t.content.length), Math.min(sel[1], t.content.length));
      ED.ta.scrollTop = sel[2];
      syncGutter();
    }
  }
  renderTabs();
}

// detect external changes (git pull, other editors…)
async function checkDisk() {
  const w = W();
  if (!w || document.visibilityState !== 'visible') return;
  const tabs = w.tabs.filter((t) => !t.key && t.loaded && (t.kind === 'text' || t.kind === 'image'));
  if (!tabs.length) return;
  let st;
  try { st = await api('fs.stat', { p: S.pid, paths: tabs.map((t) => t.path) }); } catch { return; }
  for (const t of tabs) {
    const m = st[t.path];
    if (m === undefined || m === t.mtime) continue;
    if (t.kind === 'image') { t.mtime = m; if (activeTab() === t) renderEditor(); continue; }
    if (m === -1) {
      if (t.conflict !== 'deleted') { t.conflict = 'deleted'; if (activeTab() === t) renderBanner(); renderTabs(); }
      continue;
    }
    if (!isDirty(t)) await reloadTab(t);
    else if (t.conflict !== 'changed') { t.conflict = 'changed'; if (activeTab() === t) renderBanner(); }
  }
}

// ---------------------------------------------------------------- tab strip
function renderTabs() {
  const strip = $('#tabs');
  const w = W();
  strip.innerHTML = '';
  if (!w) return;
  w.tabs.forEach((t, i) => {
    const desc = w.tabs.some((o) => o !== t && o.name === t.name) && t.path ? dirname(t.path) : '';
    const el = h('div', {
      class: 'tab' + (tabKey(t) === w.active ? ' active' : '') + (t.preview ? ' preview' : '') + (isDirty(t) ? ' dirty' : ''),
      title: t.key ? t.name : t.path + (t.conflict === 'deleted' ? ' (supprimé)' : ''),
      draggable: 'true',
    });
    el.innerHTML = (t.key ? `<span class="ficon" style="color:#e2c08d">${icon(t.kind === 'diff' ? 'git' : 'file')}</span>` : fileIcon(t.name)) +
      `<span class="tname"${t.conflict === 'deleted' ? ' style="text-decoration:line-through"' : ''}>${esc(t.name)}</span>` + (desc ? `<span class="tdesc">${esc(desc)}</span>` : '') +
      `<span class="tclose" title="Fermer (Alt+W)">${icon('close')}</span>`;
    el.addEventListener('mousedown', (e) => { if (e.button === 1) { e.preventDefault(); closeTab(t); } });
    el.addEventListener('click', (e) => {
      if (e.target.closest('.tclose')) { closeTab(t); return; }
      activateTab(tabKey(t));
    });
    el.addEventListener('dblclick', () => { t.preview = false; renderTabs(); });
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      ctxMenu(e.clientX, e.clientY, [
        { label: 'Fermer', kb: 'Alt+W', action: () => closeTab(t) },
        { label: 'Fermer les autres', action: () => closeTabs(w.tabs.filter((x) => x !== t)) },
        { label: 'Fermer à droite', action: () => closeTabs(w.tabs.slice(i + 1)) },
        { label: 'Fermer les onglets enregistrés', action: () => closeTabs(w.tabs.filter((x) => !isDirty(x))) },
        { label: 'Tout fermer', action: () => closeTabs(w.tabs) },
        '-',
        t.path ? { label: 'Copier le chemin relatif', action: () => copyText(t.path) } : null,
        t.path ? { label: 'Copier le chemin complet', action: () => copyText(fullPath(t.path)) } : null,
        t.path && !t.key ? { label: "Afficher dans l'explorateur", action: () => { showView('explorer'); revealInExplorer(t.path, true); } } : null,
        t.preview ? { label: "Garder l'onglet ouvert", action: () => { t.preview = false; renderTabs(); } } : null,
      ]);
    });
    el.addEventListener('dragstart', (e) => { e.dataTransfer.setData('dash/tab', String(i)); el.classList.add('dragging'); });
    el.addEventListener('dragend', () => el.classList.remove('dragging'));
    el.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('dash/tab')) e.preventDefault(); });
    el.addEventListener('drop', (e) => {
      const from = +e.dataTransfer.getData('dash/tab');
      if (isNaN(from) || from === i) return;
      e.preventDefault();
      const [moved] = w.tabs.splice(from, 1);
      w.tabs.splice(i, 0, moved);
      renderTabs();
      saveUI();
    });
    strip.appendChild(el);
  });
  const a = $('.tab.active', strip);
  a && a.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  document.title = (activeTab() ? activeTab().name + ' — ' : '') + (P() ? P().name + ' — ' : '') + 'Dash Lite';
}

function fullPath(rel) {
  const p = P();
  if (!p) return rel;
  const sep = S.app.sep;
  return p.path.replace(/[\\/]+$/, '') + sep + rel.split('/').join(sep);
}

// ---------------------------------------------------------------- editor
const ED = {};
function buildEditor() {
  const host = $('#editor-host');
  ED.welcome = h('div', { class: 'welcome' });
  ED.split = h('div', { class: 'split' });
  ED.wrap = h('div', { class: 'ed-wrap' });
  ED.gutter = h('div', { class: 'gutter' });
  ED.ta = h('textarea', { class: 'editor', spellcheck: 'false', autocapitalize: 'off', autocomplete: 'off', wrap: 'off' });
  ED.main = h('div', { class: 'ed-main' });
  ED.hl = h('pre', { class: 'hl', 'aria-hidden': 'true' });
  ED.hlInner = h('div', { class: 'hl-inner' });
  ED.hlLine = h('div', { class: 'hl-curline' });
  ED.hl.append(ED.hlLine, ED.hlInner);
  ED.cfxBg = h('div', { class: 'cfx-layer' });
  ED.cfxBtns = h('div', { class: 'cfx-layer cfx-top' });
  ED.measure = h('div', { class: 'ed-measure', 'aria-hidden': 'true' });
  ED.main.append(ED.cfxBg, ED.hl, ED.ta, ED.cfxBtns, ED.measure);
  ED.wrap.append(ED.gutter, ED.main);
  window.addEventListener('resize', () => { scheduleHL(); scheduleGutter(); });
  // the editor width also changes with the sidebar, the sashes and the split preview
  if (window.ResizeObserver) {
    let lastW = 0;
    new ResizeObserver(() => { const w = ED.ta.clientWidth; if (w && w !== lastW) { lastW = w; scheduleGutter(); scheduleHL(); } }).observe(ED.ta);
  }
  ED.ta.addEventListener('focus', () => ED.hl.classList.add('focused'));
  ED.ta.addEventListener('blur', () => ED.hl.classList.remove('focused'));
  ED.preview = h('div', { class: 'preview' });
  ED.md = h('div', { class: 'md' });
  ED.preview.appendChild(ED.md);
  ED.split.append(ED.wrap, ED.preview);
  ED.other = h('div', { class: 'split' });
  ED.banner = h('div', { class: 'banner', hidden: true });
  host.append(ED.welcome, ED.split, ED.other, ED.banner);
  ED.cbar = h('div', { class: 'cfx-bar', hidden: true });
  host.before(ED.cbar);
  ED.mdbar = buildMdToolbar();
  host.before(ED.mdbar);

  ED.ta.addEventListener('input', onEditorInput);
  ED.ta.addEventListener('copy', onClipboardEvent);
  ED.ta.addEventListener('cut', onClipboardEvent);
  ED.ta.addEventListener('paste', onPasteLine);
  ED.ta.addEventListener('scroll', () => { syncGutterScroll(); syncPreviewScroll(); scheduleHL(); });
  ED.ta.addEventListener('keydown', onEditorKey);
  for (const ev of ['keyup', 'click', 'select', 'focus']) ED.ta.addEventListener(ev, () => renderCursor());
  ED.preview.addEventListener('click', onPreviewClick);
  ED.preview.addEventListener('dblclick', (e) => {
    const t = activeTab();
    const el = e.target.closest('[data-line]');
    if (!t || !el || t.mode !== 'split') return;
    revealLine(t, +el.dataset.line + 1);
  });
  ED.preview.addEventListener('scroll', () => { /* independent */ });
}

let lastGutterCount = -1;
let lastGutterKey = '';
function wrapOn() { return setting('wrap', true); }
function syncGutter() {
  const t = activeTab();
  if (!t || t.kind !== 'text') return;
  if (wrapOn()) { syncWrapGutter(); syncGutterScroll(); return; }
  ED.geom = null;
  ED.wrap.classList.remove('nogutter');
  lastGutterKey = '';
  const n = ED.ta.value.split('\n').length;
  if (n !== lastGutterCount) {
    lastGutterCount = n;
    let s = '';
    for (let i = 1; i <= n; i++) s += i + '\n';
    ED.gutter.textContent = s + '\n\n';
    ED.gutter.style.width = Math.max(48, String(n).length * 9 + 28) + 'px';
  }
  syncGutterScroll();
}
function syncGutterScroll() { ED.gutter.scrollTop = ED.ta.scrollTop; }

// Soft wrap: each logical line may take several visual rows. A hidden mirror with the same
// width and font measures every line so that line numbers stay in front of their line.
const WRAP_GUTTER_MAX = 5000;
let gutterFrame = 0;
function scheduleGutter() {
  if (gutterFrame) return;
  gutterFrame = requestAnimationFrame(() => { gutterFrame = 0; syncGutter(); });
}
function syncWrapGutter() {
  const v = ED.ta.value;
  const width = ED.ta.clientWidth;
  if (!width || ED.wrap.hidden) return;
  const key = width + '|' + getComputedStyle(ED.ta).fontSize + '|' + ED.ta.style.tabSize + '|' + v;
  if (key === lastGutterKey) return;
  lastGutterKey = key;
  lastGutterCount = -1;
  const lines = v.split('\n');
  if (lines.length > WRAP_GUTTER_MAX) {
    ED.geom = null;
    ED.wrap.classList.add('nogutter');
    return;
  }
  ED.wrap.classList.remove('nogutter');
  const m = ED.measure;
  m.style.width = width + 'px';
  m.style.tabSize = ED.ta.style.tabSize;
  m.innerHTML = lines.map((l) => '<div>' + (esc(l) || ' ') + '</div>').join('');
  const base = m.getBoundingClientRect().top;
  const tops = new Array(lines.length);
  const heights = new Array(lines.length);
  const kids = m.children;
  for (let i = 0; i < kids.length; i++) {
    const r = kids[i].getBoundingClientRect();
    tops[i] = r.top - base;
    heights[i] = r.height;
  }
  m.innerHTML = '';
  ED.geom = { tops, heights };
  let s = '';
  for (let i = 0; i < lines.length; i++) s += `<div style="height:${heights[i]}px">${i + 1}</div>`;
  ED.gutter.innerHTML = s;
  ED.gutter.style.width = Math.max(48, String(lines.length).length * 9 + 28) + 'px';
  scheduleHL();
}

// ---------------------------------------------------------------- syntax highlighting overlay
const HLS = { lines: null, text: null, lang: null, frame: 0 };
function scheduleHL() {
  if (HLS.frame) return;
  HLS.frame = requestAnimationFrame(() => { HLS.frame = 0; renderHL(); renderConflicts(); });
}
function hlOff() {
  ED.ta.classList.remove('hl-on');
  ED.hl.hidden = true;
}
function renderHL() {
  const t = activeTab();
  if (!t || t.kind !== 'text' || ED.cur !== t || ED.wrap.hidden || !setting('syntax', true)) { hlOff(); return; }
  const lang = DashHL.langFor(t.path);
  const v = ED.ta.value;
  if (!lang || v.length > 2000000) { hlOff(); return; }
  if (HLS.text !== v) { HLS.text = v; HLS.lines = v.split('\n'); }
  const lines = HLS.lines;
  const wrap = setting('wrap', true);
  if (wrap && lines.length > 4000) { hlOff(); return; }
  const ta = ED.ta;
  const lh = parseFloat(getComputedStyle(ta).lineHeight) || 21;
  let from = 0, to = lines.length;
  if (!wrap) {
    from = Math.max(0, Math.floor((ta.scrollTop - 8) / lh) - 40);
    to = Math.min(lines.length, Math.ceil((ta.scrollTop + ta.clientHeight) / lh) + 40);
  }
  const html = DashHL.render(lang, lines, from, to);
  ED.hlInner.style.paddingTop = (8 + from * lh) + 'px';
  ED.hlInner.style.width = wrap ? ta.clientWidth + 'px' : '';
  ED.hlInner.innerHTML = html.join('\n') + '\n';
  ED.hlInner.style.transform = `translate(${-ta.scrollLeft}px, ${-ta.scrollTop}px)`;
  ED.hl.classList.toggle('wrap', wrap);
  ED.hl.hidden = false;
  ta.classList.add('hl-on');
  // current line
  if (!wrap) {
    const ln = v.slice(0, ta.selectionStart).split('\n').length;
    ED.hlLine.style.top = (8 + (ln - 1) * lh - ta.scrollTop) + 'px';
    ED.hlLine.style.height = lh + 'px';
    ED.hlLine.hidden = ta.selectionStart !== ta.selectionEnd;
  } else if (ED.geom) {
    const ln = v.slice(0, ta.selectionStart).split('\n').length;
    ED.hlLine.style.top = (8 + (ED.geom.tops[ln - 1] || 0) - ta.scrollTop) + 'px';
    ED.hlLine.style.height = (ED.geom.heights[ln - 1] || lh) + 'px';
    ED.hlLine.hidden = ta.selectionStart !== ta.selectionEnd;
  } else ED.hlLine.hidden = true;
}
let syncingPreview = false;
function syncPreviewScroll() {
  const t = activeTab();
  if (!t || t.mode !== 'split' || syncingPreview) return;
  const max = ED.ta.scrollHeight - ED.ta.clientHeight;
  const ratio = max > 0 ? ED.ta.scrollTop / max : 0;
  ED.preview.scrollTop = ratio * (ED.preview.scrollHeight - ED.preview.clientHeight);
}

function storeEditorState() {
  const t = activeTab();
  if (!t || t.kind !== 'text') return;
  t.sel = [ED.ta.selectionStart, ED.ta.selectionEnd];
  t.scroll = ED.ta.scrollTop;
  t.pscroll = ED.preview.scrollTop;
}

function renderWelcome() {
  const hasProject = !!P();
  ED.welcome.innerHTML = '';
  ED.welcome.append(
    h('div', { html: icon('logo', 'logo') }),
    h('h2', { text: hasProject ? P().name : 'Dash Lite' }),
    h('div', { class: 'muted', text: hasProject ? 'Ouvrez un fichier dans l’explorateur ou avec ' + MOD + '+P.' : 'Ajoutez un dossier de projet pour commencer.' }),
    h('div', { class: 'actions' },
      hasProject ? h('button', { class: 'btn', text: 'Ouvrir un fichier…', onclick: () => runCmd('file.quickOpen') }) : null,
      hasProject ? h('button', { class: 'btn secondary', text: 'Tâches', onclick: () => showView('tasks') }) : null,
      h('button', { class: 'btn' + (hasProject ? ' secondary' : ''), text: 'Ajouter un dossier…', onclick: () => runCmd('project.add') }),
      h('button', { class: 'btn secondary', text: 'Cloner un dépôt…', onclick: () => runCmd('project.clone') })),
    h('table', { html: [
      ['Ouvrir un fichier', MOD + '+P'], ['Palette de commandes', MOD + '+Maj+P'], ['Changer de projet', MOD + '+R'],
      ['Lancer une commande', MOD + '+Maj+B'], ['Terminal', MOD + '+`'], ['Tâches', MOD + '+Maj+X'],
    ].map(([a, b]) => `<tr><td class="muted">${a}</td><td><kbd>${b}</kbd></td></tr>`).join('') }));
}

function renderEditor() {
  const t = activeTab();
  ED.welcome.hidden = ED.split.hidden = ED.other.hidden = true;
  ED.banner.hidden = true;
  ED.mdbar.hidden = true;
  if (!t) {
    ED.welcome.hidden = false;
    renderWelcome();
    renderBreadcrumb();
    renderStatus();
    return;
  }
  if (!t.loaded) { ED.other.hidden = false; ED.other.innerHTML = '<div class="info-view">Chargement…</div>'; return; }
  if (t.kind === 'text') {
    ED.split.hidden = false;
    const md = isMd(t.path);
    const mode = md ? t.mode || 'edit' : 'edit';
    ED.wrap.hidden = mode === 'preview';
    ED.preview.hidden = mode === 'edit';
    ED.mdbar.hidden = !md || mode === 'preview';
    if (ED.ta.value !== t.content || ED.cur !== t) {
      ED.ta.value = t.content;
      lastGutterCount = -1;
    }
    ED.cur = t;
    const wrap = setting('wrap', true);
    ED.ta.classList.toggle('wrap', wrap);
    ED.wrap.classList.toggle('wrap', wrap);
    ED.ta.setAttribute('wrap', wrap ? 'soft' : 'off');
    ED.ta.style.tabSize = t.indent === '\t' ? 4 : (t.indent || '    ').length;
    ED.hlInner.style.tabSize = ED.ta.style.tabSize;
    syncGutter();
    if (t.sel) ED.ta.setSelectionRange(t.sel[0], t.sel[1]); else ED.ta.setSelectionRange(0, 0);
    ED.ta.scrollTop = t.scroll || 0;
    syncGutterScroll();
    renderHL();
    if (md && mode !== 'edit') {
      renderPreview(t);
      if (mode === 'preview') ED.preview.scrollTop = t.pscroll || 0;
      else syncPreviewScroll();
    }
    renderBanner();
  } else {
    ED.cur = null;
    ED.other.hidden = false;
    ED.other.innerHTML = '';
    if (t.kind === 'image') {
      ED.other.appendChild(h('div', { class: 'viewer' }, h('img', { src: rawUrl(t.pid, t.path) + '&m=' + (t.mtime || 0), alt: t.name })));
    } else if (t.kind === 'diff') {
      ED.other.appendChild(renderDiff(t));
    } else {
      const msg = t.kind === 'binary' ? 'Ce fichier est binaire et ne peut pas être affiché.' : t.kind === 'large' ? `Ce fichier est trop volumineux pour l'éditeur (${Math.round(t.size / 1048576)} Mo).` : `Impossible d'ouvrir ce fichier : ${t.error || 'introuvable'}`;
      ED.other.appendChild(h('div', { class: 'info-view' }, h('div', { text: msg }),
        t.kind !== 'missing' ? h('button', { class: 'btn secondary', text: 'Afficher dans le dossier', onclick: () => api('os.reveal', { p: t.pid, path: t.path }).catch(toastErr) }) : null));
    }
    renderBanner();
  }
  renderBreadcrumb();
  renderStatus();
  renderConflicts();
  if (currentView === 'sections') drawSections();
}

function renderBanner() {
  const t = activeTab();
  ED.banner.hidden = true;
  if (!t || !t.conflict) return;
  ED.banner.innerHTML = '';
  if (t.conflict === 'deleted') {
    ED.banner.append(h('span', { class: 'grow', text: 'Ce fichier a été supprimé ou déplacé sur le disque.' }),
      t.kind === 'text' ? h('button', { class: 'btn', text: 'Le recréer avec ce contenu', onclick: () => saveTab(t, { force: true }) }) : null,
      h('button', { class: 'btn secondary', text: "Fermer l'onglet", onclick: () => closeTab(t, { force: true }) }));
  } else {
    ED.banner.append(h('span', { class: 'grow', text: 'Le fichier a été modifié sur le disque (git pull, autre éditeur…), et vous avez des modifications non enregistrées.' }),
      h('button', { class: 'btn secondary', text: 'Recharger (perdre mes modifications)', onclick: () => reloadTab(t) }),
      h('button', { class: 'btn', text: 'Écraser avec ma version', onclick: () => saveTab(t, { force: true }) }));
  }
  ED.banner.hidden = false;
}

function renderBreadcrumb() {
  const bc = $('#breadcrumb');
  const t = activeTab();
  bc.innerHTML = '';
  if (!t || !t.path) return;
  const parts = t.path.split('/');
  parts.forEach((p, i) => {
    if (i) bc.appendChild(h('span', { class: 'sep', html: icon('right') }));
    bc.appendChild(h('span', { class: 'seg', text: p }));
  });
  if (t.kind === 'text') {
    bc.appendChild(h('span', { class: 'bc-sec', title: 'Aller à une section (' + MOD + '+Maj+O)', onclick: () => sectionPicker() }));
    updateBreadcrumbSection();
  }
  if (t.kind === 'text' && isMd(t.path)) {
    const acts = h('span', { class: 'bc-actions' });
    for (const [m, label, title] of [['edit', 'Éditer', 'Éditeur seul'], ['split', 'Partagé', 'Éditeur + aperçu'], ['preview', 'Aperçu', 'Aperçu seul (' + MOD + '+Maj+V)']]) {
      acts.appendChild(h('button', { class: 'mode-btn' + ((t.mode || 'edit') === m ? ' on' : ''), text: label, title, onclick: () => setMdMode(t, m) }));
    }
    bc.appendChild(acts);
  }
}

function setMdMode(t, mode) {
  storeEditorState();
  t.mode = mode;
  W().mdModes[t.path] = mode;
  renderEditor();
  if (mode !== 'preview') ED.ta.focus();
  saveUI();
}

// ---------------------------------------------------------------- markdown preview
function resolveRel(base, src) {
  if (/^(https?:|data:|blob:)/i.test(src)) return src;
  const clean = decodeURIComponent(src.split('#')[0].split('?')[0]);
  return src.startsWith('/') ? normPath(clean) : joinPath(dirname(base), clean);
}
function renderPreview(t) {
  const render = DashMD.createRenderer({
    resolveImg: (src) => (/^(https?:|data:)/i.test(src) ? src : rawUrl(t.pid, resolveRel(t.path, src))),
  });
  ED.md.innerHTML = render(t.content);
  decoratePreviewHeadings(t);
}
const schedulePreview = debounce(() => { const t = activeTab(); if (t && t.kind === 'text' && isMd(t.path) && t.mode !== 'edit') { syncingPreview = true; renderPreview(t); syncingPreview = false; syncPreviewScroll(); } }, 120);

function onPreviewClick(e) {
  const t = activeTab();
  if (!t) return;
  if (e.target.closest('.fold')) { onFoldClick(t, e.target); return; }
  const box = e.target.closest('input[type=checkbox][data-line]');
  if (box) {
    e.preventDefault();
    toggleTaskInTab(t, +box.dataset.line);
    return;
  }
  const a = e.target.closest('a[data-href]');
  if (!a) return;
  e.preventDefault();
  const href = a.dataset.href.replace(/&amp;/g, '&');
  if (/^https?:\/\//i.test(href)) { api('os.openUrl', { url: href }).catch(toastErr); return; }
  if (/^mailto:/i.test(href)) { copyText(href.slice(7)); return; }
  if (href.startsWith('#')) {
    const el = ED.md.querySelector('#' + CSS.escape(decodeURIComponent(href.slice(1)).toLowerCase()));
    el && el.scrollIntoView({ block: 'start' });
    return;
  }
  const target = resolveRel(t.path, href);
  if (target) openFile(target, { preview: false });
}

const TASK_LINE = /^(\s*(?:[-*+]|\d+[.)])\s+\[)([ xX])(\])/;
function toggleTaskInTab(t, ln) {
  const lines = t.content.split('\n');
  const line = lines[ln];
  if (line == null || !TASK_LINE.test(line)) return;
  const wasClean = !isDirty(t);
  lines[ln] = line.replace(TASK_LINE, (_, a, x, b) => a + (x === ' ' ? 'x' : ' ') + b);
  setTabContent(t, lines.join('\n'));
  if (wasClean) saveTab(t);
}

// replace whole content while keeping the view
function setTabContent(t, content) {
  t.content = content;
  if (activeTab() === t) {
    const s = ED.ta.selectionStart, e = ED.ta.selectionEnd, sc = ED.ta.scrollTop, ps = ED.preview.scrollTop;
    ED.ta.value = content;
    ED.ta.setSelectionRange(s, e);
    ED.ta.scrollTop = sc;
    syncGutter();
    scheduleHL();
    if (isMd(t.path) && t.mode !== 'edit') { renderPreview(t); ED.preview.scrollTop = ps; }
  }
  renderTabs();
  renderStatus();
}

// ---------------------------------------------------------------- editing
const autosave = debounce(() => {
  if (!setting('autosave', false)) return;
  const w = W();
  if (w) for (const t of w.tabs) if (isDirty(t) && !t.conflict) saveTab(t);
}, 1000);

function onEditorInput() {
  const t = activeTab();
  if (!t || t.kind !== 'text') return;
  const wasDirty = isDirty(t);
  t.content = ED.ta.value;
  if (t.preview) { t.preview = false; renderTabs(); }
  else if (wasDirty !== isDirty(t)) renderTabs();
  if (wrapOn()) scheduleGutter(); else syncGutter();
  scheduleHL();
  schedulePreview();
  refreshSectionsSoon();
  autosave();
  renderCursor();
}

function insertText(text) {
  // execCommand keeps the native undo stack
  if (!document.execCommand('insertText', false, text)) {
    ED.ta.setRangeText(text, ED.ta.selectionStart, ED.ta.selectionEnd, 'end');
    onEditorInput();
  }
}

function lineBounds(v, pos) {
  const s = v.lastIndexOf('\n', pos - 1) + 1;
  let e = v.indexOf('\n', pos);
  if (e < 0) e = v.length;
  return [s, e];
}

function onEditorKey(e) {
  const ta = ED.ta;
  const t = activeTab();
  if (!t || t.kind !== 'text') return;
  const v = ta.value;
  const indent = t.indent || '    ';
  const mod = e.ctrlKey || e.metaKey;
  if (e.key === 'Tab' && !mod && !e.altKey) {
    e.preventDefault();
    const s = ta.selectionStart, en = ta.selectionEnd;
    const multi = v.slice(s, en).includes('\n');
    if (!multi && !e.shiftKey) {
      // in a list item, Tab indents the item
      const [ls, le] = lineBounds(v, s);
      const line = v.slice(ls, le);
      if (isMd(t.path) && /^\s*([-*+]|\d+[.)])\s/.test(line) && s === en && v.slice(ls, s).trim().length <= line.trim().length) {
        ta.setSelectionRange(ls, ls);
        insertText(indent);
        ta.setSelectionRange(s + indent.length, s + indent.length);
        return;
      }
      insertText(indent === '\t' ? '\t' : ' '.repeat(indent.length - ((s - ls) % indent.length)));
      return;
    }
    const [ls] = lineBounds(v, s);
    const [, le] = lineBounds(v, en > s && v[en - 1] === '\n' ? en - 1 : en);
    const block = v.slice(ls, le);
    const lines = block.split('\n');
    let firstDelta = 0;
    const out = lines.map((l, i) => {
      if (!e.shiftKey) { if (!l.length && lines.length > 1) return l; if (i === 0) firstDelta = indent.length; return indent + l; }
      const m = l.match(indent === '\t' ? /^\t/ : new RegExp('^ {1,' + indent.length + '}|^\\t'));
      if (!m) return l;
      if (i === 0) firstDelta = -m[0].length;
      return l.slice(m[0].length);
    }).join('\n');
    ta.setSelectionRange(ls, le);
    insertText(out);
    if (multi) ta.setSelectionRange(ls, ls + out.length);
    else { const p = Math.max(ls, s + firstDelta); ta.setSelectionRange(p, p); }
    return;
  }
  if (e.key === 'Enter' && mod && !e.shiftKey) {
    e.preventDefault();
    toggleCurrentLineTask();
    return;
  }
  if (e.key === 'Enter' && !mod && !e.shiftKey && !e.altKey && !e.isComposing) {
    const s = ta.selectionStart;
    const [ls] = lineBounds(v, s);
    const before = v.slice(ls, s);
    if (isMd(t.path)) {
      const m = before.match(/^(\s*)([-*+]|(\d+)([.)]))(\s+)(\[[ xX]\]\s+)?(.*)$/);
      if (m) {
        e.preventDefault();
        if (!m[7].trim() && ta.selectionStart === ta.selectionEnd && v.slice(s, lineBounds(v, s)[1]).trim() === '') {
          // empty item: end the list
          ta.setSelectionRange(ls, s);
          insertText(m[1].length ? m[1].slice(indent.length) : '');
          return;
        }
        const marker = m[3] ? (parseInt(m[3], 10) + 1) + m[4] : m[2];
        insertText('\n' + m[1] + marker + m[5] + (m[6] ? '[ ] ' : ''));
        return;
      }
      const q = before.match(/^(\s*>+\s?)/);
      if (q) { e.preventDefault(); insertText('\n' + q[1]); return; }
    }
    const ind = before.match(/^[\t ]*/)[0];
    let extra = '';
    if (/[{[(:]\s*$/.test(before) && !isMd(t.path)) extra = indent === '\t' ? '\t' : indent;
    if (ind || extra) { e.preventDefault(); insertText('\n' + ind + extra); }
    return;
  }
  if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && !mod) {
    e.preventDefault();
    moveLines(e.key === 'ArrowUp' ? -1 : 1);
    return;
  }
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  // Ctrl+X / Ctrl+C without a selection cut / copy the whole line (as in VS Code)
  if (mod && !e.shiftKey && !e.altKey && (key === 'x' || key === 'c') && ta.selectionStart === ta.selectionEnd) {
    e.preventDefault();
    copyLines(key === 'x');
    return;
  }
  // Ctrl+Shift+D copies the current line(s) and pastes them below; the cursor / selection follows the copy
  if (mod && e.shiftKey && !e.altKey && key === 'd') {
    e.preventDefault();
    const s = ta.selectionStart, en = ta.selectionEnd;
    const [ls, le] = selectedLineRange(v, s, en);
    copyLines(false);
    const block = v.slice(ls, le);
    ta.setSelectionRange(le, le);
    insertText('\n' + block);
    const d = le - ls + 1;
    ta.setSelectionRange(s + d, en + d);
    return;
  }
  if (mod && key === 'd' && !e.shiftKey) { // duplicate line
    e.preventDefault();
    const [ls, le] = lineBounds(v, ta.selectionStart);
    const line = v.slice(ls, le);
    const off = ta.selectionStart - ls;
    ta.setSelectionRange(le, le);
    insertText('\n' + line);
    ta.setSelectionRange(le + 1 + off, le + 1 + off);
    return;
  }
  if (mod && e.key === '/' ) {
    e.preventDefault();
    toggleComment();
  }
}

// ---------------------------------------------------------------- line clipboard
// Text put on the clipboard by copyLines(); the copy event handler hands it to the browser,
// which keeps the native clipboard working without asking for a permission.
ED.pendingClip = null;
ED.lineClip = null; // last whole-line copy: pasting it inserts a line above the cursor
function selectedLineRange(v, s, en) {
  const [ls] = lineBounds(v, s);
  const [, le] = lineBounds(v, en > s && v[en - 1] === '\n' ? en - 1 : en);
  return [ls, le];
}
function copyLines(cut) {
  const ta = ED.ta;
  const v = ta.value;
  const s = ta.selectionStart, en = ta.selectionEnd;
  const [ls, le] = selectedLineRange(v, s, en);
  const text = v.slice(ls, le) + '\n';
  ED.pendingClip = text;
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  if (!ok || ED.pendingClip !== null) {
    ED.pendingClip = null;
    if (navigator.clipboard) navigator.clipboard.writeText(text).catch(() => toast('Copie impossible', 'err'));
  }
  ED.lineClip = text;
  if (cut) {
    let a = ls, b = le;
    if (le < v.length) b = le + 1; // take the line break with the line
    else if (ls > 0) a = ls - 1; // last line: remove the preceding line break instead
    ta.setSelectionRange(a, b);
    if (!document.execCommand('delete')) { ta.setRangeText('', a, b, 'start'); onEditorInput(); }
    const nv = ta.value;
    const p = lineBounds(nv, Math.min(a === ls ? ls : a, nv.length))[0];
    ta.setSelectionRange(p, p);
  }
  return text.split('\n').length - 1;
}
function onClipboardEvent(e) {
  if (ED.pendingClip === null) return;
  e.preventDefault();
  e.clipboardData.setData('text/plain', ED.pendingClip);
  ED.pendingClip = null;
}
function onPasteLine(e) {
  const ta = ED.ta;
  const text = e.clipboardData && e.clipboardData.getData('text/plain');
  if (!ED.lineClip || ta.selectionStart !== ta.selectionEnd || text.replace(/\r\n/g, '\n') !== ED.lineClip) return;
  // a whole line copied with Ctrl+C/X/Shift+D goes above the current line
  e.preventDefault();
  const pos = ta.selectionStart;
  const [ls] = lineBounds(ta.value, pos);
  ta.setSelectionRange(ls, ls);
  insertText(ED.lineClip);
  const p = pos + ED.lineClip.length;
  ta.setSelectionRange(p, p);
}

function moveLines(dir) {
  const ta = ED.ta;
  const v = ta.value;
  const s = ta.selectionStart, en = ta.selectionEnd;
  const [ls] = lineBounds(v, s);
  const [, le] = lineBounds(v, en);
  if (dir < 0 && ls === 0) return;
  if (dir > 0 && le >= v.length) return;
  const block = v.slice(ls, le);
  if (dir < 0) {
    const [ps] = lineBounds(v, ls - 1);
    const prev = v.slice(ps, ls - 1);
    ta.setSelectionRange(ps, le);
    insertText(block + '\n' + prev);
    ta.setSelectionRange(s - prev.length - 1, en - prev.length - 1);
  } else {
    const [, ne] = lineBounds(v, le + 1);
    const next = v.slice(le + 1, ne);
    ta.setSelectionRange(ls, ne);
    insertText(next + '\n' + block);
    ta.setSelectionRange(s + next.length + 1, en + next.length + 1);
  }
}

const COMMENTS = { js: '//', ts: '//', jsx: '//', tsx: '//', go: '//', rs: '//', java: '//', kt: '//', c: '//', cpp: '//', cs: '//', dart: '//', php: '//', swift: '//', scss: '//', py: '#', sh: '#', bash: '#', zsh: '#', rb: '#', yml: '#', yaml: '#', toml: '#', ps1: '#', ini: ';', sql: '--', lua: '--', bat: 'REM', cmd: 'REM' };
function toggleComment() {
  const t = activeTab();
  const ext = t.path.split('.').pop().toLowerCase();
  let tok = COMMENTS[ext] || (/^(makefile|dockerfile|\.env.*|\.gitignore)$/i.test(t.name) ? '#' : null);
  const ta = ED.ta;
  const v = ta.value;
  const [ls] = lineBounds(v, ta.selectionStart);
  const [, le] = lineBounds(v, ta.selectionEnd);
  const lines = v.slice(ls, le).split('\n');
  if (isMd(t.path) || ext === 'html' || ext === 'xml' || ext === 'vue' || ext === 'svg') {
    const block = v.slice(ls, le);
    const m = block.match(/^(\s*)<!--\s?([\s\S]*?)\s?-->\s*$/);
    ta.setSelectionRange(ls, le);
    insertText(m ? m[1] + m[2] : '<!-- ' + block + ' -->');
    return;
  }
  if (ext === 'css') {
    const block = v.slice(ls, le);
    const m = block.match(/^(\s*)\/\*\s?([\s\S]*?)\s?\*\/\s*$/);
    ta.setSelectionRange(ls, le);
    insertText(m ? m[1] + m[2] : '/* ' + block + ' */');
    return;
  }
  if (!tok) return;
  const all = lines.filter((l) => l.trim()).every((l) => l.trimStart().startsWith(tok));
  const minInd = Math.min(...lines.filter((l) => l.trim()).map((l) => l.match(/^\s*/)[0].length));
  const out = lines.map((l) => {
    if (!l.trim()) return l;
    if (all) return l.replace(new RegExp('^(\\s*)' + tok.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&') + ' ?'), '$1');
    return l.slice(0, minInd) + tok + ' ' + l.slice(minInd);
  }).join('\n');
  ta.setSelectionRange(ls, le);
  insertText(out);
  ta.setSelectionRange(ls, ls + out.length);
}

function toggleCurrentLineTask() {
  const ta = ED.ta;
  const v = ta.value;
  const pos = ta.selectionStart;
  const [ls, le] = lineBounds(v, pos);
  const line = v.slice(ls, le);
  let out;
  if (TASK_LINE.test(line)) out = line.replace(TASK_LINE, (_, a, x, b) => a + (x === ' ' ? 'x' : ' ') + b);
  else if (/^(\s*)([-*+]|\d+[.)])\s+/.test(line)) out = line.replace(/^(\s*([-*+]|\d+[.)])\s+)/, '$1[ ] ');
  else out = line.replace(/^(\s*)/, '$1- [ ] ');
  const delta = out.length - line.length;
  ta.setSelectionRange(ls, le);
  insertText(out);
  ta.setSelectionRange(pos + delta, pos + delta);
}

// ---------------------------------------------------------------- markdown toolbar
// Every action goes through insertText(), so Ctrl+Z undoes it like typing.
const MD_ICONS = {
  bold: '<path d="M4.5 2.5h4.2a2.8 2.8 0 0 1 0 5.6H4.5zM4.5 8.1h5a2.7 2.7 0 0 1 0 5.4h-5z"/>',
  italic: '<path d="M7 2.5h5M4 13.5h5M9.5 2.5l-3 11"/>',
  strike: '<path d="M2.5 8h11M11 4.2C10.4 3.1 9.3 2.5 8 2.5c-1.9 0-3.2 1-3.2 2.4 0 .8.4 1.5 1.2 2M5 11.6c.6 1.2 1.7 1.9 3.2 1.9 2 0 3.3-1 3.3-2.5 0-.5-.1-1-.4-1.4"/>',
  code: '<path d="m5.5 4-4 4 4 4M10.5 4l4 4-4 4"/>',
  ul: '<circle cx="2.8" cy="4" r=".9"/><circle cx="2.8" cy="8" r=".9"/><circle cx="2.8" cy="12" r=".9"/><path d="M6 4h8M6 8h8M6 12h8"/>',
  ol: '<path d="M6 4h8M6 8h8M6 12h8M2 2.8h1v3M1.8 9.2c.3-.5 1.7-.6 1.7.3 0 .6-1.7 1.4-1.7 2h1.8"/>',
  task: '<rect x="1.5" y="2.5" width="5" height="5" rx=".8"/><path d="m2.7 5 1 1 1.7-2M9 5h5.5M1.5 9.5h5v4h-5zM9 11.5h5.5"/>',
  quote: '<path d="M3 3.5v9M6 5h7.5M6 8h7.5M6 11h5"/>',
  link: '<path d="m6.5 9.5 3-3M7 4.5l1-1a2.5 2.5 0 0 1 3.5 3.5l-1 1M9 11.5l-1 1A2.5 2.5 0 0 1 4.5 9l1-1"/>',
  image: '<rect x="1.5" y="2.5" width="13" height="11" rx="1.2"/><circle cx="5.5" cy="6" r="1.2"/><path d="m1.5 12 4-4 3 3 2-2 4 4"/>',
  codeblock: '<rect x="1.5" y="2.5" width="13" height="11" rx="1.2"/><path d="m6 6-2 2 2 2M10 6l2 2-2 2"/>',
  table: '<rect x="1.5" y="2.5" width="13" height="11" rx="1.2"/><path d="M1.5 6.2h13M1.5 9.8h13M6 2.5v11M10.5 2.5v11"/>',
  hr: '<path d="M1.5 8h13M4 4.5h8M4 11.5h8" opacity=".9"/>',
  note: '<path d="M2.5 2.5h11v8h-6l-3 3v-3h-2z"/><path d="M8 4.8v2.6M8 9v.1"/>',
};
function mdIcon(n) { return `<svg class="ico" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round">${MD_ICONS[n]}</svg>`; }

function buildMdToolbar() {
  const bar = h('div', { class: 'md-bar', hidden: true, role: 'toolbar', 'aria-label': 'Insérer du Markdown' });
  const btn = (html, title, fn, cls = '') => h('button', {
    class: 'md-btn ' + cls, title, html,
    onmousedown: (e) => e.preventDefault(), // keep the editor focus and selection
    onclick: (e) => { const t = activeTab(); if (!t || t.kind !== 'text') return; ED.ta.focus(); fn(e, t); },
  });
  const sep = () => h('span', { class: 'md-sep' });
  const menuAt = (e, items) => { const r = e.currentTarget.getBoundingClientRect(); ctxMenu(r.left, r.bottom + 2, items); };
  bar.append(
    btn('Titre <span class="caret">▾</span>', 'Titre (H1 à H6)', (e) => menuAt(e, [
      ...[1, 2, 3, 4, 5, 6].map((n) => ({ label: 'Titre ' + n + '  ' + '#'.repeat(n), action: () => { ED.ta.focus(); mdHeading(n); } })),
      '-', { label: 'Texte normal', action: () => { ED.ta.focus(); mdHeading(0); } },
    ]), 'md-text'),
    sep(),
    btn(mdIcon('bold'), 'Gras  **texte**', () => mdInline('**', '**', 'texte en gras')),
    btn(mdIcon('italic'), 'Italique  *texte*', () => mdInline('*', '*', 'texte en italique')),
    btn(mdIcon('strike'), 'Barré  ~~texte~~', () => mdInline('~~', '~~', 'texte barré')),
    btn(mdIcon('code'), 'Code en ligne  `code`', () => mdInline('`', '`', 'code')),
    sep(),
    btn(mdIcon('ul'), 'Liste à puces', () => mdLinePrefix('ul')),
    btn(mdIcon('ol'), 'Liste numérotée', () => mdLinePrefix('ol')),
    btn(mdIcon('task'), 'Liste de tâches  - [ ]', () => mdLinePrefix('task')),
    btn(mdIcon('quote'), 'Citation  >', () => mdLinePrefix('quote')),
    sep(),
    btn(mdIcon('link'), 'Lien  [texte](url)', () => mdLink(false)),
    btn(mdIcon('image'), 'Image  ![texte](chemin)', () => mdLink(true)),
    btn(mdIcon('codeblock'), 'Bloc de code  ```', () => mdCodeBlock()),
    btn(mdIcon('table'), 'Tableau', () => mdBlock('| Colonne 1 | Colonne 2 | Colonne 3 |\n| --- | --- | --- |\n|  |  |  |', 2, 9)),
    btn(mdIcon('hr'), 'Ligne horizontale  ---', () => mdBlock('---')),
    btn(mdIcon('note') + '<span class="caret">▾</span>', 'Encadré  > [!NOTE]', (e) => menuAt(e, [
      ['NOTE', 'Note'], ['TIP', 'Astuce'], ['IMPORTANT', 'Important'], ['WARNING', 'Attention'], ['CAUTION', 'Danger'],
    ].map(([k, l]) => ({ label: l + '  [!' + k + ']', action: () => { ED.ta.focus(); mdCallout(k); } })))));
  return bar;
}

function selLinesInfo() {
  const ta = ED.ta;
  const v = ta.value;
  const s = ta.selectionStart, en = ta.selectionEnd;
  const [ls, le] = selectedLineRange(v, s, en);
  return { v, s, en, ls, le, lines: v.slice(ls, le).split('\n') };
}
function replaceLines(ls, le, out, s, en, firstDelta, totalDelta) {
  const ta = ED.ta;
  ta.setSelectionRange(ls, le);
  insertText(out);
  if (s === en) { const p = Math.max(ls, s + firstDelta); ta.setSelectionRange(p, p); }
  else ta.setSelectionRange(Math.max(ls, s + firstDelta), Math.max(ls, en + totalDelta));
}

function mdInline(before, after, placeholder) {
  const ta = ED.ta;
  const v = ta.value;
  let s = ta.selectionStart, en = ta.selectionEnd;
  // already wrapped: remove the markers
  if (v.slice(s - before.length, s) === before && v.slice(en, en + after.length) === after && (before !== '*' || v[s - 2] !== '*' || v[en + 1] === '*')) {
    ta.setSelectionRange(s - before.length, en + after.length);
    insertText(v.slice(s, en));
    ta.setSelectionRange(s - before.length, en - before.length);
    return;
  }
  const sel = v.slice(s, en);
  if (sel.length > 2 && sel.startsWith(before) && sel.endsWith(after)) {
    const inner = sel.slice(before.length, sel.length - after.length);
    insertText(inner);
    ta.setSelectionRange(s, s + inner.length);
    return;
  }
  // keep surrounding spaces outside the markers
  const lead = sel.match(/^\s*/)[0], trail = sel.slice(lead.length).match(/\s*$/)[0];
  const core = sel.slice(lead.length, sel.length - trail.length) || placeholder;
  insertText(lead + before + core + after + trail);
  const a = s + lead.length + before.length;
  ta.setSelectionRange(a, a + core.length);
}

const LIST_MARK = /^(\s*)(?:[-*+]\s+\[[ xX]\]\s+|[-*+]\s+|\d+[.)]\s+|>\s?)/;
function mdLinePrefix(kind) {
  const { s, en, ls, le, lines } = selLinesInfo();
  const test = { ul: /^\s*[-*+]\s+(?!\[[ xX]\])/, ol: /^\s*\d+[.)]\s+/, task: /^\s*[-*+]\s+\[[ xX]\]\s+/, quote: /^\s*>/ }[kind];
  const filled = lines.filter((l) => l.trim());
  const all = filled.length > 0 && filled.every((l) => test.test(l));
  let n = 0, firstDelta = 0, total = 0;
  const out = lines.map((l, i) => {
    if (!l.trim() && lines.length > 1) return l;
    let nl;
    if (all) nl = l.replace(LIST_MARK, '$1');
    else {
      const m = l.match(LIST_MARK);
      const ind = m ? m[1] : l.match(/^\s*/)[0];
      const body = m ? l.slice(m[0].length) : l.slice(ind.length);
      n++;
      const mark = kind === 'ul' ? '- ' : kind === 'ol' ? n + '. ' : kind === 'task' ? '- [ ] ' : '> ';
      nl = ind + mark + body;
    }
    if (i === 0) firstDelta = nl.length - l.length;
    total += nl.length - l.length;
    return nl;
  }).join('\n');
  replaceLines(ls, le, out, s, en, firstDelta, total);
}

function mdHeading(level) {
  const { s, en, ls, le, lines } = selLinesInfo();
  let firstDelta = 0, total = 0;
  const out = lines.map((l, i) => {
    if (!l.trim() && lines.length > 1) return l;
    const body = l.replace(/^\s*#{1,6}(\s+|$)/, '');
    const nl = level ? '#'.repeat(level) + ' ' + body : body;
    if (i === 0) firstDelta = nl.length - l.length;
    total += nl.length - l.length;
    return nl;
  }).join('\n');
  replaceLines(ls, le, out, s, en, firstDelta, total);
}

function mdLink(image) {
  const ta = ED.ta;
  const v = ta.value;
  const s = ta.selectionStart, en = ta.selectionEnd;
  const sel = v.slice(s, en);
  const isUrl = /^(https?:\/\/|\.{0,2}\/|[\w-]+\.(png|jpe?g|gif|svg|webp|md)$)\S*$/i.test(sel.trim());
  const label = isUrl ? (image ? 'image' : 'texte') : sel || (image ? 'description' : 'texte du lien');
  const url = isUrl ? sel.trim() : image ? 'chemin/image.png' : 'https://';
  const text = (image ? '!' : '') + '[' + label + '](' + url + ')';
  insertText(text);
  // select what is left to type: the URL, or the label when the URL was selected
  const lStart = s + (image ? 2 : 1);
  if (isUrl) ta.setSelectionRange(lStart, lStart + label.length);
  else { const uStart = lStart + label.length + 2; ta.setSelectionRange(uStart, uStart + url.length); }
}

// insert a block (text without final line break) on its own lines, separated by blank lines
function mdBlock(text, selFrom, selLen) {
  const ta = ED.ta;
  const v = ta.value;
  const [ls] = lineBounds(v, ta.selectionStart);
  const [, le] = lineBounds(v, ta.selectionEnd);
  let a, b, pre = '';
  if (!v.slice(ls, le).trim()) { // empty line: use it
    a = ls; b = le;
    if (ls > 0 && v.slice(lineBounds(v, ls - 1)[0], ls - 1).trim()) pre = '\n';
  } else { a = b = le; pre = '\n\n'; }
  let post = '';
  if (b >= v.length) post = '\n';
  else { const [ns, ne] = lineBounds(v, b + 1); if (v.slice(ns, ne).trim()) post = '\n'; }
  ta.setSelectionRange(a, b);
  insertText(pre + text + post);
  const start = a + pre.length;
  if (selFrom != null) ta.setSelectionRange(start + selFrom, start + selFrom + (selLen || 0));
  else { const p = Math.min(ta.value.length, start + text.length + 1); ta.setSelectionRange(p, p); }
}

function mdCodeBlock() {
  const ta = ED.ta;
  const v = ta.value;
  const s = ta.selectionStart, en = ta.selectionEnd;
  if (s !== en) {
    const { ls, le } = selLinesInfo();
    const block = v.slice(ls, le);
    ta.setSelectionRange(ls, le);
    insertText('```\n' + block + '\n```');
    ta.setSelectionRange(ls + 3, ls + 3); // cursor where the language goes
    return;
  }
  mdBlock('```\n\n```', 4, 0);
}

function mdCallout(kind) {
  const ta = ED.ta;
  const v = ta.value;
  const s = ta.selectionStart, en = ta.selectionEnd;
  if (s !== en) {
    const { ls, le, lines } = selLinesInfo();
    const out = '> [!' + kind + ']\n' + lines.map((l) => '> ' + l).join('\n');
    ta.setSelectionRange(ls, le);
    insertText(out);
    ta.setSelectionRange(ls + out.length, ls + out.length);
    return;
  }
  const head = '> [!' + kind + ']\n> ';
  mdBlock(head, head.length, 0);
}

function revealLine(t, line, col, len) {
  if (t.kind !== 'text') return;
  if (t.mode === 'preview') setMdMode(t, 'split');
  const lines = t.content.split('\n');
  line = Math.max(1, Math.min(line, lines.length));
  let off = 0;
  for (let i = 0; i < line - 1; i++) off += lines[i].length + 1;
  const start = off + Math.min(col || 0, lines[line - 1].length);
  ED.ta.focus();
  ED.ta.setSelectionRange(start, start + (len || 0));
  const lh = parseFloat(getComputedStyle(ED.ta).lineHeight) || 21;
  syncGutter();
  const y = ED.geom && wrapOn() ? ED.geom.tops[line - 1] || 0 : (line - 1) * lh;
  ED.ta.scrollTop = Math.max(0, y - ED.ta.clientHeight / 3);
  syncGutterScroll();
  renderCursor();
}

function cursorInfo() {
  const t = activeTab();
  if (!t || t.kind !== 'text' || ED.cur !== t) return null;
  const pos = ED.ta.selectionStart;
  const before = ED.ta.value.slice(0, pos);
  const ln = before.split('\n').length;
  const col = pos - before.lastIndexOf('\n');
  const selLen = Math.abs(ED.ta.selectionEnd - ED.ta.selectionStart);
  return { ln, col, selLen };
}
const renderCursor = debounce(() => { renderStatus(); scheduleHL(); onCursorSections(); }, 30);

// ---------------------------------------------------------------- diff view
function renderDiff(t) {
  const wrap = h('div', { class: 'split', style: { flexDirection: 'column' } });
  const head = h('div', { class: 'diff-head' }, h('span', { class: 'grow muted', style: { flex: 1 }, text: t.subtitle || '' }));
  if (t.path && !t.commit) head.appendChild(h('button', { class: 'btn secondary', text: 'Ouvrir le fichier', onclick: () => openFile(t.path, { preview: false }) }));
  const view = h('div', { class: 'diff-view' });
  const lines = (t.diff || '').split('\n');
  const frag = [];
  for (const l of lines.slice(0, 20000)) {
    let cls = '';
    if (/^(diff --git|index |--- |\+\+\+ |new file|deleted file|similarity|rename |old mode|new mode|commit |Author:|Date:)/.test(l)) cls = 'meta';
    else if (l.startsWith('@@')) cls = 'hunk';
    else if (l.startsWith('+')) cls = 'add';
    else if (l.startsWith('-')) cls = 'del';
    frag.push(`<div${cls ? ` class="${cls}"` : ''}>${esc(l) || ' '}</div>`);
  }
  view.innerHTML = frag.join('') || '<div class="meta">(aucune différence)</div>';
  wrap.append(head, view);
  return wrap;
}
