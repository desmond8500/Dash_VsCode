'use strict';
/* global S, W, P, $, $$, h, api, icon, fileIcon, esc, toast, toastErr, modal, prompt, confirmBox, showOutput, ctxMenu, debounce, basename, dirname, joinPath, normPath, isMd, setting, setSetting, openFile, openVirtual, findTab, closeTab, reloadTab, isDirty, toggleTaskInTab, saveTab, activeTab, fullPath, copyText, saveUI, activateProject, loadState, runCommand, showPanel, renderStatus, renderTabs, renderEditor, relTime, hl, MOD, runCmd */

const VIEWS = [
  { id: 'explorer', icon: 'files', title: 'Explorateur', kb: 'Ctrl+Maj+E' },
  { id: 'search', icon: 'search', title: 'Rechercher', kb: 'Ctrl+Maj+F' },
  { id: 'git', icon: 'git', title: 'Git', kb: 'Ctrl+Maj+G' },
  { id: 'tasks', icon: 'tasks', title: 'Tâches', kb: 'Ctrl+Maj+X' },
  { id: 'sections', icon: 'outline', title: 'Sections', kb: 'Ctrl+Maj+O' },
  { id: 'commands', icon: 'commands', title: 'Commandes', kb: 'Ctrl+Maj+B' },
  { id: 'projects', icon: 'projects', title: 'Projets', kb: 'Ctrl+R' },
];
let currentView = 'explorer';

function buildActivity() {
  const bar = $('#activity');
  bar.innerHTML = '';
  for (const v of VIEWS) {
    bar.appendChild(h('button', { class: 'act', 'data-view': v.id, title: `${v.title} (${v.kb.replace('Ctrl', MOD)})`, html: icon(v.icon) + '<span class="badge" hidden></span>', onclick: () => {
      if (currentView === v.id && !document.body.classList.contains('no-side')) { document.body.classList.add('no-side'); return; }
      showView(v.id);
    } }));
  }
  bar.appendChild(h('div', { class: 'spacer' }));
  bar.appendChild(h('button', { class: 'act', title: 'Paramètres', html: icon('gear'), onclick: (e) => mainMenu(e.currentTarget, true) }));
}

function setBadge(view, n) {
  const b = $(`#activity .act[data-view="${view}"] .badge`);
  if (!b) return;
  b.hidden = !n;
  b.textContent = n > 999 ? '999+' : n;
}

function showView(id, { focus = true } = {}) {
  currentView = id;
  document.body.classList.remove('no-side');
  $$('#activity .act').forEach((a) => a.classList.toggle('active', a.dataset.view === id));
  const w = W();
  if (w) { w.view = id; saveUI(); }
  renderSidebar(focus);
}

function sideHead(title, actions = []) {
  $('.side-title').textContent = title;
  const acts = $('.side-actions');
  acts.innerHTML = '';
  for (const a of actions) {
    if (!a) continue;
    acts.appendChild(h('button', { class: 'icon-btn' + (a.on ? ' on' : ''), title: a.title, html: icon(a.icon), onclick: a.action }));
  }
}

function renderSidebar(focus) {
  const body = $('.side-body');
  if (!P() && currentView !== 'projects') {
    sideHead(VIEWS.find((v) => v.id === currentView).title);
    body.innerHTML = '';
    body.appendChild(h('div', { class: 'empty' }, h('div', { text: 'Aucun projet ouvert.' }),
      h('button', { class: 'btn block', text: 'Ajouter un dossier', onclick: () => runCmd('project.add') }),
      h('button', { class: 'btn secondary block', style: { marginTop: '6px' }, text: 'Cloner un dépôt', onclick: () => runCmd('project.clone') })));
    return;
  }
  ({ explorer: renderExplorer, search: renderSearch, git: renderGit, tasks: renderTasks, sections: renderSections, commands: renderCommands, projects: renderProjects })[currentView](focus);
}

// ================================================================ explorer
function dirCache() { const w = W(); if (!w.dirs) w.dirs = new Map(); return w.dirs; }

async function loadDir(dir, force) {
  const c = dirCache();
  if (c.has(dir) && !force) return c.get(dir);
  try {
    const list = await api('fs.list', { p: S.pid, path: dir });
    c.set(dir, list);
    return list;
  } catch (e) {
    c.set(dir, []);
    if (dir === '') toastErr(e);
    return [];
  }
}

async function refreshExplorer() {
  const w = W();
  if (!w) return;
  const dirs = [''].concat([...w.expanded]);
  const c = dirCache();
  await Promise.all(dirs.map(async (d) => {
    try { c.set(d, await api('fs.list', { p: S.pid, path: d })); } catch { c.delete(d); w.expanded.delete(d); }
  }));
  if (currentView === 'explorer') drawTree();
}

function renderExplorer(focus) {
  const w = W();
  sideHead('Explorateur', [
    { icon: 'newfile', title: 'Nouveau fichier (Alt+N)', action: () => newEntry(false) },
    { icon: 'newfolder', title: 'Nouveau dossier', action: () => newEntry(true) },
    { icon: 'filter', title: 'Markdown seulement', on: w.mdOnly, action: () => { w.mdOnly = !w.mdOnly; renderExplorer(); saveUI(); } },
    { icon: 'refresh', title: "Actualiser l'explorateur", action: refreshExplorer },
    { icon: 'collapse', title: 'Tout réduire', action: () => { w.expanded.clear(); drawTree(); saveUI(); } },
  ]);
  const body = $('.side-body');
  body.innerHTML = '';
  const head = h('div', { class: 'section-head', title: P().path },
    h('span', { class: 'tw open', html: icon('right') }), h('span', { class: 'grow', text: P().name }));
  const tree = h('div', { class: 'tree', tabindex: '0' });
  body.append(head, tree);
  tree.addEventListener('keydown', treeKey);
  tree.addEventListener('contextmenu', (e) => {
    if (e.target.closest('.row')) return;
    e.preventDefault();
    entryMenu(e, { path: '', dir: true, root: true });
  });
  tree.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('dash/path')) e.preventDefault(); });
  tree.addEventListener('drop', (e) => { if (!e.target.closest('.row')) dropOn(e, ''); });
  drawTree();
  if (focus) tree.focus({ preventScroll: true });
}

async function drawTree() {
  const tree = $('.side-body .tree');
  const w = W();
  if (!tree || !w) return;
  const rows = [];
  const walk = async (dir, depth) => {
    const list = await loadDir(dir);
    for (const e of list) {
      const path = dir ? dir + '/' + e.name : e.name;
      if (!e.dir && w.mdOnly && !isMd(e.name)) continue;
      rows.push({ ...e, path, depth });
      if (e.dir && w.expanded.has(path)) await walk(path, depth + 1);
    }
  };
  await walk('', 0);
  if (!$('.side-body .tree') || W() !== w) return;
  const dirty = new Set(w.tabs.filter(isDirty).map((t) => t.path));
  const git = gitDecor();
  const frag = document.createDocumentFragment();
  for (const r of rows) {
    const g = git.get(r.path);
    const el = h('div', {
      class: 'row' + (w.sel === r.path ? ' sel' : ''),
      'data-path': r.path, 'data-dir': r.dir ? '1' : '', draggable: 'true',
      style: { paddingLeft: 8 + r.depth * 12 + 'px' },
      title: r.path + (r.link ? ' (lien)' : ''),
    });
    el.innerHTML = `<span class="tw${r.dir && w.expanded.has(r.path) ? ' open' : ''}">${r.dir ? icon('right') : ''}</span>` + fileIcon(r.name, r.dir, w.expanded.has(r.path)) +
      `<span class="name"${g ? ` style="color:${g.color}"` : ''}>${esc(r.name)}</span>` +
      (dirty.has(r.path) ? '<span class="st" title="Non enregistré">●</span>' : g && !r.dir ? `<span class="st" style="color:${g.color}">${g.letter}</span>` : g && r.dir ? `<span class="st" style="color:${g.color};font-size:9px">●</span>` : '');
    el.addEventListener('click', () => onRowClick(r, false));
    el.addEventListener('dblclick', () => { if (!r.dir) openFile(r.path, { preview: false }); });
    el.addEventListener('contextmenu', (e) => { e.preventDefault(); selectRow(r.path); entryMenu(e, r); });
    el.addEventListener('dragstart', (e) => { e.dataTransfer.setData('dash/path', r.path); e.dataTransfer.effectAllowed = 'move'; });
    el.addEventListener('dragover', (e) => { if (r.dir && e.dataTransfer.types.includes('dash/path')) { e.preventDefault(); el.classList.add('drop-target'); } });
    el.addEventListener('dragleave', () => el.classList.remove('drop-target'));
    el.addEventListener('drop', (e) => { el.classList.remove('drop-target'); if (r.dir) { e.stopPropagation(); dropOn(e, r.path); } });
    frag.appendChild(el);
  }
  if (!rows.length) frag.appendChild(h('div', { class: 'empty', text: w.mdOnly ? 'Aucun fichier Markdown à ce niveau.' : 'Dossier vide.' }));
  tree.innerHTML = '';
  tree.appendChild(frag);
}

function gitDecor() {
  const m = new Map();
  const g = W() && W().git;
  if (!g || !g.repo) return m;
  const color = (f) => (f.conflict ? '#e35a5a' : f.untracked || f.x === 'A' ? '#73c991' : f.x === 'D' || f.y === 'D' ? '#c74e39' : '#e2c08d');
  for (const f of g.files) {
    const path = f.path.replace(/\/$/, '');
    const c = color(f);
    m.set(path, { color: c, letter: f.conflict ? '!' : f.untracked ? 'U' : (f.y !== '.' ? f.y : f.x) });
    let d = dirname(path);
    while (d) { if (!m.has(d)) m.set(d, { color: c, letter: '' }); d = dirname(d); }
  }
  return m;
}

function selectRow(path) {
  const w = W();
  w.sel = path;
  $$('.side-body .tree .row').forEach((el) => el.classList.toggle('sel', el.dataset.path === path));
}

async function onRowClick(r, pin) {
  selectRow(r.path);
  if (r.dir) {
    const w = W();
    if (w.expanded.has(r.path)) w.expanded.delete(r.path);
    else { await loadDir(r.path); w.expanded.add(r.path); }
    drawTree();
    saveUI();
  } else openFile(r.path, { preview: !pin, focus: pin, reveal: false });
}

async function revealInExplorer(path, focus) {
  const w = W();
  if (!w || !path) return;
  let d = dirname(path);
  const toOpen = [];
  while (d) { toOpen.unshift(d); d = dirname(d); }
  for (const x of toOpen) { if (!w.expanded.has(x)) { await loadDir(x); w.expanded.add(x); } }
  w.sel = path;
  if (currentView === 'explorer' && $('.side-body .tree')) {
    await drawTree();
    const el = $(`.side-body .tree .row[data-path="${CSS.escape(path)}"]`);
    el && el.scrollIntoView({ block: 'nearest' });
    if (focus) $('.side-body .tree').focus();
  }
}

function visibleRows() { return $$('.side-body .tree .row'); }

function treeKey(e) {
  const w = W();
  const rows = visibleRows();
  const i = rows.findIndex((r) => r.dataset.path === w.sel);
  const cur = rows[i];
  const curInfo = cur && { path: cur.dataset.path, dir: !!cur.dataset.dir, name: basename(cur.dataset.path) };
  const go = (k) => { const r = rows[Math.max(0, Math.min(rows.length - 1, k))]; if (r) { selectRow(r.dataset.path); r.scrollIntoView({ block: 'nearest' }); } };
  if (e.key === 'ArrowDown') { e.preventDefault(); go(i + 1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); go(i < 0 ? 0 : i - 1); }
  else if (e.key === 'Home') { e.preventDefault(); go(0); }
  else if (e.key === 'End') { e.preventDefault(); go(rows.length - 1); }
  else if (!curInfo) return;
  else if (e.key === 'ArrowRight') { e.preventDefault(); if (curInfo.dir && !w.expanded.has(curInfo.path)) onRowClick(curInfo); else if (curInfo.dir) go(i + 1); }
  else if (e.key === 'ArrowLeft') {
    e.preventDefault();
    if (curInfo.dir && w.expanded.has(curInfo.path)) onRowClick(curInfo);
    else { const parent = dirname(curInfo.path); if (parent) { selectRow(parent); const el = rows.find((r) => r.dataset.path === parent); el && el.scrollIntoView({ block: 'nearest' }); } }
  }
  else if (e.key === 'Enter') { e.preventDefault(); if (curInfo.dir) onRowClick(curInfo); else openFile(curInfo.path, { preview: false }); }
  else if (e.key === ' ') { e.preventDefault(); if (!curInfo.dir) openFile(curInfo.path, { preview: true, focus: false, reveal: false }); }
  else if (e.key === 'F2') { e.preventDefault(); renameEntry(curInfo); }
  else if (e.key === 'Delete' || (e.key === 'Backspace' && (e.metaKey))) { e.preventDefault(); deleteEntry(curInfo); }
}

function entryMenu(e, r) {
  const dir = r.dir ? r.path : dirname(r.path);
  ctxMenu(e.clientX, e.clientY, [
    { label: 'Nouveau fichier…', kb: 'Alt+N', action: () => newEntry(false, dir) },
    { label: 'Nouveau dossier…', action: () => newEntry(true, dir) },
    '-',
    !r.dir && !r.root ? { label: 'Ouvrir', action: () => openFile(r.path, { preview: false }) } : null,
    !r.root ? { label: 'Renommer…', kb: 'F2', action: () => renameEntry(r) } : null,
    !r.root ? { label: 'Supprimer', kb: 'Suppr', danger: true, action: () => deleteEntry(r) } : null,
    !r.root ? '-' : null,
    { label: 'Copier le chemin', action: () => copyText(fullPath(r.path)) },
    !r.root ? { label: 'Copier le chemin relatif', action: () => copyText(r.path) } : null,
    { label: 'Afficher dans le dossier système', action: () => api('os.reveal', { p: S.pid, path: r.path }).catch(toastErr) },
    { label: 'Ouvrir dans le terminal', action: () => openTerminalAt(dir) },
    !r.dir && isMd(r.path) ? { label: 'Définir comme fichier des tâches', action: () => setTodoFile(r.path) } : null,
  ]);
}

function inlineInput(dir, isDir) {
  // shows an editable row at the top of `dir`
  return new Promise(async (resolve) => {
    const w = W();
    if (dir && !w.expanded.has(dir)) { await loadDir(dir); w.expanded.add(dir); await drawTree(); }
    const tree = $('.side-body .tree');
    if (!tree) { resolve(null); return; }
    const parentRow = dir ? $(`.row[data-path="${CSS.escape(dir)}"]`, tree) : null;
    const depth = dir ? dir.split('/').length : 0;
    const input = h('input', { class: 'rename-input', spellcheck: 'false' });
    const row = h('div', { class: 'row', style: { paddingLeft: 8 + depth * 12 + 'px' } }, h('span', { class: 'tw' }), h('span', { html: fileIcon('x', isDir) }), input);
    if (parentRow) parentRow.after(row); else tree.prepend(row);
    let done = false;
    const end = (v) => { if (done) return; done = true; row.remove(); resolve(v); };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); end(input.value.trim()); }
      if (e.key === 'Escape') { e.preventDefault(); end(null); }
      e.stopPropagation();
    });
    input.addEventListener('blur', () => end(input.value.trim() || null));
    input.focus();
  });
}

async function newEntry(isDir, dir) {
  if (!P()) return;
  if (dir === undefined) {
    const w = W();
    const sel = w.sel;
    const isSelDir = sel && dirCache().has(sel);
    dir = sel ? (isSelDir ? sel : dirname(sel)) : '';
  }
  if (currentView !== 'explorer') showView('explorer', { focus: false });
  const name = await inlineInput(dir, isDir);
  if (!name) return;
  const path = normPath(joinPath(dir, name));
  try {
    await api('fs.create', { p: S.pid, path, dir: isDir });
    await loadDir(dirname(path), true);
    if (isDir) { W().expanded.add(path); dirCache().set(path, []); }
    W().sel = path;
    await drawTree();
    if (!isDir) openFile(path, { preview: false });
  } catch (e) { toastErr(e); }
}

async function renameEntry(r) {
  const name = basename(r.path);
  const dot = name.lastIndexOf('.');
  const v = await prompt('Renommer', { value: r.path, label: 'Nouveau chemin (relatif au projet)', select: [r.path.length - name.length, r.path.length - name.length + (dot > 0 && !r.dir ? dot : name.length)] });
  if (!v || normPath(v) === r.path) return;
  const to = normPath(v);
  try {
    await api('fs.rename', { p: S.pid, from: r.path, to });
    const w = W();
    for (const t of w.tabs) {
      if (t.key) continue;
      if (t.path === r.path || t.path.startsWith(r.path + '/')) {
        t.path = to + t.path.slice(r.path.length);
        t.name = basename(t.path);
        if (w.active === r.path || (w.active || '').startsWith(r.path + '/')) w.active = t.path;
      }
    }
    if (w.expanded.has(r.path)) { w.expanded.delete(r.path); w.expanded.add(to); }
    w.sel = to;
    dirCache().clear();
    renderTabs();
    await refreshExplorer();
    saveUI();
  } catch (e) { toastErr(e); }
}

async function deleteEntry(r) {
  const ok = await confirmBox('Supprimer', `Supprimer définitivement « ${r.path} »${r.dir ? ' et tout son contenu' : ''} ? Cette action est irréversible.`, { ok: 'Supprimer', danger: true });
  if (!ok) return;
  try {
    await api('fs.delete', { p: S.pid, path: r.path });
    const w = W();
    for (const t of w.tabs.slice()) if (!t.key && (t.path === r.path || t.path.startsWith(r.path + '/'))) await closeTab(t, { force: true });
    w.expanded.delete(r.path);
    await loadDir(dirname(r.path), true);
    drawTree();
  } catch (e) { toastErr(e); }
}

async function dropOn(e, dir) {
  e.preventDefault();
  const from = e.dataTransfer.getData('dash/path');
  if (!from || from === dir || dir.startsWith(from + '/') || dirname(from) === dir) return;
  const to = joinPath(dir, basename(from));
  try {
    await api('fs.rename', { p: S.pid, from, to });
    for (const t of W().tabs) if (!t.key && (t.path === from || t.path.startsWith(from + '/'))) { t.path = to + t.path.slice(from.length); t.name = basename(t.path); }
    if (W().active && W().active.startsWith(from)) W().active = to + W().active.slice(from.length);
    dirCache().clear();
    renderTabs();
    refreshExplorer();
  } catch (err) { toastErr(err); }
}

// ================================================================ search
const SEARCH = { q: '', regex: false, case: false, word: false, glob: '', results: null, collapsed: new Set() };
function renderSearch(focus) {
  sideHead('Rechercher', [
    { icon: 'refresh', title: 'Relancer la recherche', action: () => doSearch() },
    { icon: 'collapse', title: 'Tout réduire', action: () => { if (SEARCH.results) { SEARCH.results.hits.forEach((x) => SEARCH.collapsed.add(x.path)); drawSearch(); } } },
  ]);
  const body = $('.side-body');
  body.innerHTML = '';
  const tog = (k, label, title) => h('button', { class: 'icon-btn' + (SEARCH[k] ? ' on' : ''), title, text: label, onclick: (e) => { SEARCH[k] = !SEARCH[k]; e.currentTarget.classList.toggle('on', SEARCH[k]); doSearch(); } });
  const q = h('input', { class: 'input', placeholder: 'Rechercher', value: SEARCH.q, spellcheck: 'false' });
  const glob = h('input', { class: 'input', placeholder: 'Fichiers à inclure (ex. *.md, src/)', value: SEARCH.glob, spellcheck: 'false', style: { marginTop: '6px', fontSize: '12px' } });
  const deb = debounce(() => doSearch(), 350);
  q.addEventListener('input', () => { SEARCH.q = q.value; deb(); });
  glob.addEventListener('input', () => { SEARCH.glob = glob.value; deb(); });
  q.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });
  body.append(h('div', { class: 'pad' }, h('div', { class: 'input-wrap' }, q, h('span', { class: 'toggles' }, tog('case', 'Aa', 'Respecter la casse'), tog('word', 'ab', 'Mot entier'), tog('regex', '.*', 'Expression régulière'))), glob),
    h('div', { class: 'search-results' }));
  drawSearch();
  if (focus) { q.focus(); q.select(); }
}

let searchSeq = 0;
async function doSearch() {
  const my = ++searchSeq;
  if (!SEARCH.q) { SEARCH.results = null; drawSearch(); return; }
  try {
    const r = await api('search', { p: S.pid, query: SEARCH.q, regex: SEARCH.regex, case: SEARCH.case, word: SEARCH.word, glob: SEARCH.glob });
    if (my !== searchSeq) return;
    SEARCH.results = r;
    SEARCH.collapsed.clear();
  } catch (e) {
    if (my !== searchSeq) return;
    SEARCH.results = { error: e.message, hits: [] };
  }
  drawSearch();
}

function drawSearch() {
  const box = $('.side-body .search-results');
  if (!box) return;
  box.innerHTML = '';
  const r = SEARCH.results;
  if (!r) return;
  if (r.error) { box.appendChild(h('div', { class: 'empty', text: r.error })); return; }
  const groups = new Map();
  for (const hit of r.hits) { if (!groups.has(hit.path)) groups.set(hit.path, []); groups.get(hit.path).push(hit); }
  box.appendChild(h('div', { class: 'pad small muted', style: { paddingTop: 0 }, text: r.hits.length ? `${r.hits.length}${r.truncated ? '+' : ''} résultat(s) dans ${groups.size} fichier(s)` : 'Aucun résultat.' }));
  for (const [path, hits] of groups) {
    const col = SEARCH.collapsed.has(path);
    box.appendChild(h('div', { class: 'row', style: { paddingLeft: '6px' }, title: path, onclick: () => { col ? SEARCH.collapsed.delete(path) : SEARCH.collapsed.add(path); drawSearch(); } },
      h('span', { class: 'tw' + (col ? '' : ' open'), html: icon('right') }), h('span', { html: fileIcon(basename(path)) }),
      h('span', { class: 'name', text: basename(path) }), h('span', { class: 'desc', text: dirname(path) }), h('span', { class: 'count chip', style: { fontSize: '10px', padding: '0 6px' }, text: hits.length })));
    if (col) continue;
    for (const x of hits) {
      const chars = Array.from(x.text);
      const pre = chars.slice(0, x.col).join('');
      const mid = chars.slice(x.col, x.col + x.len).join('');
      const post = chars.slice(x.col + x.len).join('');
      const lead = pre.length > 40 ? '…' + pre.slice(-40) : pre;
      box.appendChild(h('div', { class: 'row search-hit', title: `${path}:${x.line}`, html: `${esc(lead.trimStart())}<mark>${esc(mid)}</mark>${esc(post)}`, onclick: () => openFile(x.path, { line: x.line, col: x.col, len: x.len }) }));
    }
  }
}

// ================================================================ git
const GIT = { collapsed: new Set(['log']), log: null, msg: {} };
async function refreshGit() {
  const w = W();
  const pid = S.pid;
  if (!w) return;
  try {
    const st = await api('git.status', { p: pid });
    if (S.ws.get(pid) !== w) return;
    w.git = st;
  } catch { return; }
  setBadge('git', w.git.repo ? w.git.files.length : 0);
  renderStatus();
  if (currentView === 'git' && S.pid === pid) drawGit();
  if (currentView === 'explorer' && S.pid === pid) drawTree();
}
const refreshGitSoon = debounce(refreshGit, 800);

async function gitOp(name, body, { title, silent, refresh = true } = {}) {
  const btns = $$('.git-tools .btn');
  btns.forEach((b) => (b.disabled = true));
  const t = silent ? null : toast((title || name) + '…', '', 0);
  try {
    const r = await api(name, { p: S.pid, ...body });
    t && t.remove();
    if (r && r.ok === false) { showOutput((title || name) + ' — échec', r.output, false); return false; }
    if (!silent) toast((title || name) + ' : terminé' + (r && r.output ? '\n' + r.output.split('\n').slice(-3).join('\n') : ''), 'ok', 3500);
    return r || true;
  } catch (e) {
    t && t.remove();
    toastErr(e);
    return false;
  } finally {
    btns.forEach((b) => (b.disabled = false));
    if (refresh) { await refreshGit(); refreshAfterGit(); }
  }
}

function refreshAfterGit() {
  // files may have changed (pull, checkout, discard)
  refreshExplorer();
  import_checkDisk();
  refreshTasksSoon();
}
function import_checkDisk() { if (typeof checkDisk === 'function') checkDisk(); }

function renderGit() {
  const w = W();
  sideHead('Git', [
    { icon: 'refresh', title: 'Actualiser', action: refreshGit },
    { icon: 'pull', title: 'Pull', action: () => gitOp('git.pull', {}, { title: 'Pull' }) },
    { icon: 'push', title: 'Push', action: () => gitOp('git.push', {}, { title: 'Push' }) },
    { icon: 'more', title: "Plus d'actions", action: (e) => gitMenu(e) },
  ]);
  drawGit();
  refreshGit();
}

function gitMenu(e) {
  const r = e.currentTarget.getBoundingClientRect();
  ctxMenu(r.left, r.bottom + 2, [
    { label: 'Synchroniser (pull + push)', action: () => gitOp('git.sync', {}, { title: 'Synchronisation' }) },
    { label: 'Fetch', action: () => gitOp('git.fetch', {}, { title: 'Fetch' }) },
    '-',
    { label: 'Changer de branche…', action: branchPicker },
    { label: 'Créer une branche…', action: createBranch },
    '-',
    { label: 'Connecter un dépôt distant…', action: setRemote },
    { label: 'Annuler le dernier commit (amend)…', action: amendCommit },
    '-',
    { label: 'Tout synchroniser (tous les projets)', action: () => runCmd('git.syncAll') },
  ]);
}

function section(id, title, count, acts, collapsedSet) {
  const col = collapsedSet.has(id);
  const head = h('div', { class: 'section-head' + (col ? ' collapsed' : ''), onclick: (e) => { if (e.target.closest('.acts')) return; col ? collapsedSet.delete(id) : collapsedSet.add(id); renderSidebar(); } },
    h('span', { html: icon('down', 'tw') }), h('span', { class: 'grow', text: title }),
    h('span', { class: 'acts' }, ...(acts || []).map((a) => h('button', { class: 'icon-btn', title: a.title, html: icon(a.icon), onclick: (e) => { e.stopPropagation(); a.action(); } }))),
    count != null ? h('span', { class: 'count', text: count }) : null);
  return { head, col };
}

function drawGit() {
  const w = W();
  const body = $('.side-body');
  if (currentView !== 'git' || !w) return;
  const g = w.git;
  const focused = document.activeElement && document.activeElement.classList.contains('git-msg-input');
  const msgVal = GIT.msg[S.pid] || '';
  body.innerHTML = '';
  if (!g) { body.appendChild(h('div', { class: 'empty', text: 'Chargement…' })); return; }
  if (g.error && !g.repo) { body.appendChild(h('div', { class: 'empty', text: g.error })); return; }
  if (!g.repo) {
    body.appendChild(h('div', { class: 'empty' },
      h('div', { text: "Ce projet n'est pas un dépôt git." }),
      h('button', { class: 'btn block', text: 'Initialiser un dépôt', onclick: () => gitOp('git.init', {}, { title: 'git init' }) }),
      h('button', { class: 'btn secondary block', style: { marginTop: '6px' }, text: 'Connecter un dépôt distant…', onclick: setRemote }),
      h('div', { class: 'small', style: { marginTop: '12px' }, text: 'Pour récupérer un dépôt existant comme nouveau projet, utilisez « Cloner un dépôt » dans la vue Projets.' })));
    return;
  }
  // branch line
  const br = h('div', { class: 'git-branch' },
    h('span', { class: 'br', title: 'Changer de branche', onclick: branchPicker, html: icon('branch') + esc(g.detached ? 'HEAD détachée' : g.branch || '?') }),
    g.upstream ? h('span', { class: 'muted', title: 'Branche amont', text: g.upstream }) : h('span', { class: 'muted', text: g.remotes.length ? 'pas de branche amont' : 'aucun remote' }),
    g.behind ? h('span', { title: 'Commits à récupérer', text: '↓' + g.behind }) : null,
    g.ahead ? h('span', { title: 'Commits à pousser', text: '↑' + g.ahead }) : null);
  const ta = h('textarea', { class: 'textarea git-msg-input', rows: '2', placeholder: `Message de commit — ✨ pour le générer, ${MOD}+Entrée pour valider`, spellcheck: 'false' });
  ta.value = msgVal;
  ta.addEventListener('input', () => (GIT.msg[S.pid] = ta.value));
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); doCommit(false); } });
  const staged = g.files.filter((f) => f.staged);
  const changes = g.files.filter((f) => f.unstaged || f.untracked);
  const gen = h('button', { class: 'icon-btn git-gen', title: 'Générer le message à partir des modifications', html: icon('sparkle'), onclick: () => generateCommitMessage() });
  const msg = h('div', { class: 'git-msg' }, h('div', { class: 'git-msg-box' }, ta, gen),
    h('div', { class: 'btn-row' },
      h('button', { class: 'btn', html: icon('check') + 'Commit', title: staged.length ? 'Valider les fichiers indexés' : 'Indexer tout et valider', onclick: () => doCommit(false) }),
      h('button', { class: 'btn secondary', html: icon('push') + 'Commit + Push', onclick: () => doCommit(true) })));
  const tools = h('div', { class: 'git-tools' },
    h('button', { class: 'btn secondary', html: icon('pull') + 'Pull', onclick: () => gitOp('git.pull', {}, { title: 'Pull' }) }),
    h('button', { class: 'btn secondary', html: icon('push') + 'Push', onclick: () => gitOp('git.push', {}, { title: 'Push' }) }),
    h('button', { class: 'btn secondary', html: icon('sync') + 'Sync', title: 'Pull puis push', onclick: () => gitOp('git.sync', {}, { title: 'Synchronisation' }) }),
    h('button', { class: 'btn secondary', html: icon('fetch'), title: 'Fetch', onclick: () => gitOp('git.fetch', {}, { title: 'Fetch' }) }));
  body.append(br, msg, tools);

  const fileRow = (f, isStaged) => {
    const letter = f.conflict ? 'U' : f.untracked ? 'U' : isStaged ? f.x : f.y;
    const cls = f.conflict ? 'U' : f.untracked ? '?' : letter;
    const name = basename(f.path.replace(/\/$/, '')) + (f.path.endsWith('/') ? '/' : '');
    const row = h('div', { class: 'row' + (letter === 'D' ? ' deleted' : ''), style: { paddingLeft: '20px' }, title: f.path + (f.orig ? ` (renommé depuis ${f.orig})` : ''),
      onclick: () => openDiff(f, isStaged) },
    h('span', { html: fileIcon(name) }), h('span', { class: 'name gs-' + cls, text: name }), h('span', { class: 'desc', text: dirname(f.path) }),
    h('span', { class: 'acts' },
      letter !== 'D' && !f.path.endsWith('/') ? h('button', { class: 'icon-btn', title: 'Ouvrir le fichier', html: icon('file'), onclick: (e) => { e.stopPropagation(); openFile(f.path, { preview: false }); } }) : null,
      !isStaged ? h('button', { class: 'icon-btn', title: 'Annuler les modifications', html: icon('discard'), onclick: (e) => { e.stopPropagation(); discard([f]); } }) : null,
      h('button', { class: 'icon-btn', title: isStaged ? 'Retirer de l’index' : 'Indexer', html: icon(isStaged ? 'minus' : 'plus'), onclick: (e) => { e.stopPropagation(); gitOp(isStaged ? 'git.unstage' : 'git.stage', { paths: [f.path] }, { silent: true }); } })),
    h('span', { class: 'st gs-' + cls, text: letter === '?' ? 'U' : letter }));
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      ctxMenu(e.clientX, e.clientY, [
        { label: 'Voir les différences', action: () => openDiff(f, isStaged) },
        letter !== 'D' ? { label: 'Ouvrir le fichier', action: () => openFile(f.path, { preview: false }) } : null,
        { label: isStaged ? 'Retirer de l’index' : 'Indexer', action: () => gitOp(isStaged ? 'git.unstage' : 'git.stage', { paths: [f.path] }, { silent: true }) },
        !isStaged ? { label: 'Annuler les modifications', danger: true, action: () => discard([f]) } : null,
        '-',
        { label: 'Copier le chemin relatif', action: () => copyText(f.path) },
      ]);
    });
    return row;
  };
  if (staged.length) {
    const s = section('staged', 'Modifications indexées', staged.length, [{ icon: 'minus', title: 'Tout retirer de l’index', action: () => gitOp('git.unstage', { paths: [] }, { silent: true }) }], GIT.collapsed);
    body.appendChild(s.head);
    if (!s.col) staged.forEach((f) => body.appendChild(fileRow(f, true)));
  }
  const s2 = section('changes', 'Modifications', changes.length, [
    { icon: 'discard', title: 'Tout annuler', action: () => discard(changes) },
    { icon: 'plus', title: 'Tout indexer', action: () => gitOp('git.stage', { paths: [] }, { silent: true }) },
  ], GIT.collapsed);
  body.appendChild(s2.head);
  if (!s2.col) {
    if (!changes.length) body.appendChild(h('div', { class: 'empty small', style: { padding: '4px 20px' }, text: 'Aucune modification.' }));
    changes.forEach((f) => body.appendChild(fileRow(f, false)));
  }
  // remotes
  const s3 = section('remote', 'Dépôt distant', g.remotes.length || null, [{ icon: 'link', title: 'Connecter / modifier', action: setRemote }], GIT.collapsed);
  body.appendChild(s3.head);
  if (!s3.col) {
    const box = h('div', { class: 'pad small' });
    body.appendChild(box);
    if (!g.remotes.length) box.append(h('div', { class: 'muted', text: 'Aucun remote configuré.' }), h('button', { class: 'btn secondary', style: { marginTop: '6px' }, text: 'Connecter un dépôt…', onclick: setRemote }));
    else api('git.remotes', { p: S.pid }).then((m) => {
      for (const [n, u] of Object.entries(m)) box.appendChild(h('div', { style: { marginBottom: '4px', wordBreak: 'break-all', userSelect: 'text' } }, h('b', { text: n + ' ' }), h('span', { class: 'muted', text: u })));
    }).catch(() => {});
  }
  // history
  const s4 = section('log', 'Historique', null, [{ icon: 'refresh', title: 'Actualiser', action: () => { GIT.log = null; drawGit(); } }], GIT.collapsed);
  body.appendChild(s4.head);
  if (!s4.col) {
    const box = h('div');
    body.appendChild(box);
    api('git.log', { p: S.pid }).then((list) => {
      if (!list.length) { box.appendChild(h('div', { class: 'empty small', text: 'Aucun commit.' })); return; }
      for (const c of list) {
        box.appendChild(h('div', { class: 'log-row', title: c.subject, onclick: () => showCommit(c) },
          h('div', { class: 's', text: c.subject }),
          h('div', { class: 'm' }, h('span', { text: c.hash }), h('span', { text: c.author }), h('span', { text: c.date }), c.refs ? h('span', { class: 'ref', text: c.refs }) : null)));
      }
    }).catch(() => {});
  }
  if (focused) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
}

// fills the commit box with a message written from the changes (offline analysis)
async function generateCommitMessage({ quiet = false } = {}) {
  const btn = $('.git-gen');
  btn && btn.classList.add('busy');
  try {
    const r = await api('git.suggest', { p: S.pid });
    GIT.msg[S.pid] = r.message;
    const ta = $('.git-msg-input');
    if (ta) {
      ta.focus();
      ta.select();
      if (!document.execCommand('insertText', false, r.message)) ta.value = r.message; // Ctrl+Z restores the previous text
      ta.style.height = Math.min(260, Math.max(54, ta.scrollHeight + 2)) + 'px';
      ta.setSelectionRange(0, r.message.split('\n')[0].length);
    }
    if (!quiet) toast(`Message proposé d'après ${r.files} fichier(s)${r.staged ? ' indexé(s)' : ''} — relisez-le puis validez.`, 'ok', 3500);
    return r.message;
  } catch (e) { toastErr(e); return null; } finally { btn && btn.classList.remove('busy'); }
}

async function doCommit(push) {
  const w = W();
  const g = w.git;
  const message = (GIT.msg[S.pid] || '').trim();
  if (!message) {
    // nothing typed: propose a message instead of failing
    if (g && g.files.length && await generateCommitMessage({ quiet: true })) toast('Message de commit proposé : relisez-le puis cliquez à nouveau sur Commit.', 'ok', 4000);
    else toast('Écrivez un message de commit.', 'err');
    return;
  }
  const staged = g.files.filter((f) => f.staged).length;
  if (!g.files.length) { toast('Rien à valider.', ''); return; }
  // unsaved editors would be left out
  const dirty = w.tabs.filter(isDirty);
  if (dirty.length) {
    const v = await modal({ title: 'Fichiers non enregistrés', body: h('p', { text: `${dirty.length} fichier(s) ont des modifications non enregistrées. Les enregistrer avant le commit ?` }),
      buttons: [{ label: 'Annuler', kind: 'secondary', value: null }, { label: 'Commit sans enregistrer', kind: 'secondary', value: 'skip' }, { label: 'Enregistrer et continuer', primary: true, value: 'save' }] });
    if (!v) return;
    if (v === 'save') for (const t of dirty) await saveTab(t);
  }
  const r = await gitOp('git.commit', { message, all: staged === 0 }, { title: 'Commit', silent: true, refresh: false });
  if (!r) { refreshGit(); return; }
  GIT.msg[S.pid] = '';
  toast('Commit effectué', 'ok', 2000);
  if (push) await gitOp('git.push', {}, { title: 'Push' });
  else await refreshGit();
}

async function discard(files) {
  if (!files.length) return;
  const untracked = files.filter((f) => f.untracked).length;
  const ok = await confirmBox('Annuler les modifications', files.length === 1
    ? `Annuler les modifications de « ${files[0].path} » ?${files[0].untracked ? ' Le fichier non suivi sera supprimé.' : ''} Cette action est irréversible.`
    : `Annuler les modifications de ${files.length} fichiers ?${untracked ? ` ${untracked} fichier(s) non suivi(s) seront supprimés.` : ''} Cette action est irréversible.`, { ok: 'Annuler les modifications', danger: true, cancel: 'Garder' });
  if (!ok) return;
  await gitOp('git.discard', { paths: files.map((f) => f.path) }, { silent: true });
}

async function openDiff(f, staged) {
  try {
    const r = await api('git.diff', { p: S.pid, path: f.path, staged, untracked: f.untracked });
    openVirtual(`diff:${staged ? 'i' : 'w'}:${f.path}`, basename(f.path) + (staged ? ' (index)' : ' (modifs)'), 'diff', { diff: r.diff, path: f.path, subtitle: f.path + (staged ? ' — modifications indexées' : ' — modifications de travail') });
  } catch (e) { toastErr(e); }
}

async function showCommit(c) {
  try {
    const r = await api('git.show', { p: S.pid, hash: c.hash });
    openVirtual('commit:' + c.hash, c.hash + ' ' + c.subject.slice(0, 30), 'diff', { diff: r.diff, commit: true, subtitle: `${c.hash} — ${c.author}, ${c.date}` });
  } catch (e) { toastErr(e); }
}

async function branchPicker() {
  let b;
  try { b = await api('git.branches', { p: S.pid }); } catch (e) { toastErr(e); return; }
  const cur = W().git && W().git.branch;
  const items = [
    { label: '+ Créer une branche…', run: createBranch },
    { sep: true, label: 'Branches locales' },
    ...b.local.map((n) => ({ label: n, desc: n === cur ? 'actuelle' : '', icon: icon('branch'), run: () => n !== cur && gitOp('git.checkout', { branch: n }, { title: 'Checkout ' + n }) })),
  ];
  const localSet = new Set(b.local);
  const remotes = b.remote.filter((r) => !localSet.has(r.replace(/^[^/]+\//, '')));
  if (remotes.length) items.push({ sep: true, label: 'Branches distantes' }, ...remotes.map((n) => ({ label: n, icon: icon('link'), run: () => gitOp('git.checkout', { branch: n, remote: true }, { title: 'Checkout ' + n }) })));
  quickPick({ placeholder: 'Choisir une branche', items });
}

async function createBranch() {
  const name = await prompt('Nouvelle branche', { placeholder: 'ex. feature/ma-fonction', label: 'Nom de la branche (créée depuis la branche actuelle)' });
  if (name) gitOp('git.checkout', { branch: name.trim(), create: true }, { title: 'Nouvelle branche' });
}

async function setRemote() {
  let cur = {};
  try { cur = await api('git.remotes', { p: S.pid }); } catch { /* not a repo yet */ }
  const name = h('input', { class: 'input', value: 'origin', spellcheck: 'false' });
  const url = h('input', { class: 'input', value: cur.origin || '', placeholder: 'git@github.com:moi/projet.git ou https://…', spellcheck: 'false' });
  name.addEventListener('input', () => { if (cur[name.value]) url.value = cur[name.value]; });
  const v = await modal({
    title: 'Connecter un dépôt distant',
    body: h('div', null,
      h('div', { class: 'field' }, h('label', { text: 'URL du dépôt' }), url, h('div', { class: 'hint', text: "Le dépôt est initialisé s'il ne l'est pas encore. L'authentification utilise votre configuration git (clé SSH ou gestionnaire d'identifiants)." })),
      h('div', { class: 'field' }, h('label', { text: 'Nom du remote' }), name)),
    buttons: [{ label: 'Annuler', kind: 'secondary', value: null }, { label: 'Enregistrer', primary: true, value: () => ({ name: name.value.trim(), url: url.value.trim() }) }],
    onOpen: () => setTimeout(() => url.focus()),
  });
  if (v && v.url) {
    const ok = await gitOp('git.setRemote', v, { title: 'Remote', silent: true });
    if (ok) toast(`Remote « ${v.name || 'origin'} » enregistré. Utilisez Push pour publier la branche.`, 'ok');
  }
}

async function amendCommit() {
  const ok = await confirmBox('Modifier le dernier commit', 'Ajouter les fichiers indexés au dernier commit (git commit --amend) ? Le message actuel du champ remplacera celui du commit s’il est rempli. À éviter si le commit a déjà été poussé.', { ok: 'Modifier le commit' });
  if (ok) { await gitOp('git.commit', { message: (GIT.msg[S.pid] || '').trim(), amend: true }, { title: 'Amend' }); GIT.msg[S.pid] = ''; }
}

// ================================================================ tasks
const TASKS = { filter: 'todo', collapsed: new Set(), section: '' };
async function refreshTasks() {
  const w = W();
  const pid = S.pid;
  if (!w) return;
  try {
    const list = await api('tasks.list', { p: pid });
    if (S.ws.get(pid) !== w) return;
    w.tasks = list;
  } catch { return; }
  setBadge('tasks', w.tasks.filter((t) => !t.done).length);
  renderStatus();
  if (currentView === 'tasks' && S.pid === pid) drawTasks();
}
const refreshTasksSoon = debounce(refreshTasks, 600);

function todoFile() { return (P() && P().todoFile) || 'TODO.md'; }
async function setTodoFile(path) {
  try {
    await api('project.update', { id: S.pid, todoFile: path });
    P().todoFile = path;
    toast('Les nouvelles tâches iront dans ' + path, 'ok', 2500);
    if (currentView === 'tasks') renderTasks();
  } catch (e) { toastErr(e); }
}

function renderTasks(focus) {
  sideHead('Tâches', [
    { icon: 'refresh', title: 'Actualiser', action: refreshTasks },
    { icon: 'collapse', title: 'Tout réduire', action: () => { (W().tasks || []).forEach((t) => TASKS.collapsed.add(t.path)); drawTasks(); } },
  ]);
  const body = $('.side-body');
  body.innerHTML = '';
  const input = h('input', { class: 'input', placeholder: 'Nouvelle tâche… (Entrée)', spellcheck: 'true' });
  const secSel = h('select', { class: 'input task-section', title: 'Section où ajouter la tâche' });
  secSel.addEventListener('change', () => { TASKS.section = secSel.value; });
  fillSectionSelect(secSel);
  input.addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter' || !input.value.trim()) return;
    const text = input.value.trim();
    input.value = '';
    await addTaskTo(todoFile(), secSel.value ? JSON.parse(secSel.value) : null, text);
    fillSectionSelect(secSel);
  });
  const target = h('div', { class: 'small muted', style: { marginTop: '4px', display: 'flex', gap: '6px', alignItems: 'center' } },
    h('span', { text: '→ ' + todoFile() }),
    h('a', { href: '#', text: 'changer', onclick: async (e) => {
      e.preventDefault();
      const v = await prompt('Fichier des tâches', { value: todoFile(), label: 'Fichier Markdown (relatif au projet) où ajouter les nouvelles tâches' });
      if (v) setTodoFile(normPath(v));
    } }),
    h('a', { href: '#', text: 'ouvrir', onclick: (e) => { e.preventDefault(); openFile(todoFile(), { preview: false }); } }));
  const chips = h('div', { class: 'chips', style: { marginTop: '8px' } });
  for (const [k, label] of [['todo', 'À faire'], ['all', 'Toutes'], ['done', 'Terminées']]) {
    chips.appendChild(h('button', { class: 'chip' + (TASKS.filter === k ? ' on' : ''), text: label, onclick: () => { TASKS.filter = k; renderTasks(); } }));
  }
  body.append(h('div', { class: 'pad' }, input, h('div', { style: { marginTop: '4px' } }, secSel), target, chips, h('div', { class: 'task-progress', style: { marginTop: '8px' } })), h('div', { class: 'task-list' }));
  drawTasks();
  refreshTasks();
  if (focus) input.focus();
}

function drawTasks() {
  const w = W();
  const box = $('.side-body .task-list');
  if (!box || !w) return;
  const all = w.tasks;
  box.innerHTML = '';
  const prog = $('.side-body .task-progress');
  if (!all) { box.appendChild(h('div', { class: 'empty', text: 'Analyse des fichiers Markdown…' })); return; }
  const done = all.filter((t) => t.done).length;
  if (prog) {
    prog.innerHTML = '';
    if (all.length) prog.append(h('div', { class: 'small muted', style: { marginBottom: '4px' }, text: `${done} / ${all.length} terminée(s)` }), h('div', { class: 'progress' }, h('div', { style: { width: (100 * done / all.length).toFixed(1) + '%' } })));
  }
  const list = all.filter((t) => TASKS.filter === 'all' || (TASKS.filter === 'done' ? t.done : !t.done));
  if (!list.length) {
    box.appendChild(h('div', { class: 'empty', text: all.length ? (TASKS.filter === 'todo' ? 'Tout est fait 🎉' : 'Aucune tâche terminée.') : 'Aucune tâche « - [ ] » trouvée dans les fichiers Markdown du projet. Ajoutez-en une ci-dessus.' }));
    return;
  }
  const byFile = new Map();
  for (const t of list) { if (!byFile.has(t.path)) byFile.set(t.path, []); byFile.get(t.path).push(t); }
  const totals = new Map();
  for (const t of all) { const x = totals.get(t.path) || [0, 0]; x[1]++; if (t.done) x[0]++; totals.set(t.path, x); }
  for (const [path, tasks] of byFile) {
    const col = TASKS.collapsed.has(path);
    const tot = totals.get(path);
    box.appendChild(h('div', { class: 'row', style: { paddingLeft: '6px' }, title: path, onclick: (e) => { if (e.target.closest('.acts')) return; col ? TASKS.collapsed.delete(path) : TASKS.collapsed.add(path); drawTasks(); } },
      h('span', { class: 'tw' + (col ? '' : ' open'), html: icon('right') }), h('span', { html: fileIcon(basename(path)) }),
      h('span', { class: 'name', text: basename(path) }), h('span', { class: 'desc', text: dirname(path) }),
      h('span', { class: 'acts' }, h('button', { class: 'icon-btn', title: 'Ouvrir', html: icon('file'), onclick: () => openFile(path, { preview: false }) })),
      h('span', { class: 'muted small', text: `${tot[0]}/${tot[1]}` })));
    if (col) continue;
    let heading = null;
    for (const t of tasks) {
      if (t.heading !== heading) {
        heading = t.heading;
        if (heading) {
          const sec = { line: t.headingLine - 1, title: heading };
          box.appendChild(h('div', { class: 'task-head' }, h('span', { class: 'grow', text: heading }),
            h('button', { class: 'icon-btn', title: 'Ajouter une tâche dans cette section', html: icon('plus'), onclick: async () => {
              const v = await prompt('Nouvelle tâche', { label: `Dans « ${heading} » (${path})` });
              if (v && v.trim()) addTaskTo(path, sec, v.trim());
            } })));
        }
      }
      const cb = h('input', { type: 'checkbox' });
      cb.checked = t.done;
      cb.addEventListener('click', (e) => { e.stopPropagation(); toggleTask(t, cb.checked); });
      box.appendChild(h('div', { class: 'task-row' + (t.done ? ' done' : ''), style: { paddingLeft: 26 + Math.min(t.indent, 12) * 6 + 'px' }, title: `${path}:${t.line}`, onclick: () => openFile(path, { line: t.line }) },
        cb, h('span', { class: 'tt', html: inlineMd(t.text) })));
    }
  }
}

// sections of the task file, for the quick-add selector
async function fillSectionSelect(sel) {
  const file = todoFile();
  let text = '';
  const t = findTab(file);
  if (t && t.loaded && t.kind === 'text') text = t.content;
  else { try { text = (await api('fs.read', { p: S.pid, path: file })).content || ''; } catch { text = ''; } }
  const { list } = parseSections(text);
  sel.innerHTML = '';
  sel.appendChild(h('option', { value: '', text: list.length ? 'Section : fin du fichier' : 'Fin du fichier' }));
  for (const s of list) sel.appendChild(h('option', { value: JSON.stringify({ line: s.line, title: s.title }), text: '\u2003'.repeat(s.depth) + (s.title || '(sans titre)') }));
  if (TASKS.section && [...sel.options].some((o) => o.value === TASKS.section)) sel.value = TASKS.section;
  sel.hidden = !list.length;
}

// adds a task to `file`, inside the section {line, title} (0-based heading line) or at the end
async function addTaskTo(file, sec, text) {
  try {
    const t = findTab(file);
    if (t && t.loaded && t.kind === 'text') {
      // the file is open: edit the buffer so nothing gets overwritten
      const wasClean = !isDirty(t);
      const { lines, list } = parseSections(t.content);
      const s = sec ? list.find((o) => o.line === sec.line) || list.find((o) => o.title === sec.title) : null;
      let out;
      if (s) out = insertTaskLines(lines, s, text).lines.join('\n');
      else {
        let c = t.content;
        if (c && !c.endsWith('\n')) c += '\n';
        if (!c) c = '# TODO\n\n';
        out = c + '- [ ] ' + text + '\n';
      }
      setTabContent(t, out);
      if (wasClean) await saveTab(t);
    } else await api('tasks.add', { p: S.pid, file, text, section: sec ? sec.line + 1 : 0 });
    refreshTasks();
  } catch (err) { toastErr(err); }
}

function inlineMd(s) {
  return esc(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/\[([^\]]+)\]\([^)]+\)/g, '<u>$1</u>');
}

async function toggleTask(task, done) {
  const t = findTab(task.path);
  try {
    if (t && t.loaded && t.kind === 'text' && isDirty(t)) {
      // unsaved buffer: edit it there, the user saves when ready
      toggleTaskInTab(t, task.line - 1);
    } else {
      await api('tasks.toggle', { p: S.pid, path: task.path, line: task.line, done });
      if (t && t.loaded) await reloadTab(t);
    }
    task.done = done;
    refreshTasks();
  } catch (e) { toastErr(e); refreshTasks(); }
}

// ================================================================ commands
const CMDS = { data: null, form: null, collapsed: new Set() };
async function refreshCommands() {
  try { CMDS.data = await api('cmds.list', { p: S.pid }); } catch (e) { CMDS.data = { saved: [], detected: [], error: e.message }; }
  if (currentView === 'commands') drawCommands();
}

function renderCommands(focus) {
  sideHead('Commandes', [
    { icon: 'plus', title: 'Nouvelle commande', action: () => { CMDS.form = {}; drawCommands(); } },
    { icon: 'refresh', title: 'Actualiser la détection', action: refreshCommands },
  ]);
  const body = $('.side-body');
  body.innerHTML = '';
  const input = h('input', { class: 'input', placeholder: 'Lancer une commande… (Entrée)', spellcheck: 'false' });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && input.value.trim()) { runCommand({ command: input.value.trim() }); input.value = ''; }
  });
  body.append(h('div', { class: 'pad' }, input), h('div', { class: 'cmd-list' }));
  drawCommands();
  refreshCommands();
  if (focus) input.focus();
}

function runningFor(cmd) {
  for (const { info } of S.sessions.values()) if (info.project === S.pid && info.kind === 'command' && info.command === cmd && info.running) return true;
  return false;
}

function drawCommands() {
  const box = $('.side-body .cmd-list');
  if (!box) return;
  box.innerHTML = '';
  const d = CMDS.data;
  if (CMDS.form) box.appendChild(cmdForm(CMDS.form));
  if (!d) { box.appendChild(h('div', { class: 'empty', text: 'Analyse du projet…' })); return; }
  const s1 = section('saved', 'Enregistrées', d.saved.length, [{ icon: 'plus', title: 'Nouvelle commande', action: () => { CMDS.form = {}; drawCommands(); } }], CMDS.collapsed);
  box.appendChild(s1.head);
  if (!s1.col) {
    if (!d.saved.length) box.appendChild(h('div', { class: 'empty small', style: { padding: '4px 20px 8px' }, text: 'Enregistrez vos commandes (build, déploiement…) avec + ou l’étoile d’une commande détectée.' }));
    d.saved.forEach((c, i) => box.appendChild(cmdRow(c, {
      acts: [
        { icon: 'edit', title: 'Modifier', action: () => { CMDS.form = { ...c }; drawCommands(); } },
        i > 0 ? { icon: 'arrowUp', title: 'Monter', action: () => api('cmds.move', { p: S.pid, id: c.id, delta: -1 }).then(refreshCommands) } : null,
        i < d.saved.length - 1 ? { icon: 'arrowDown', title: 'Descendre', action: () => api('cmds.move', { p: S.pid, id: c.id, delta: 1 }).then(refreshCommands) } : null,
        { icon: 'trash', title: 'Supprimer', action: async () => { if (await confirmBox('Supprimer la commande', `Supprimer « ${c.name} » ?`, { ok: 'Supprimer', danger: true })) api('cmds.delete', { p: S.pid, id: c.id }).then(refreshCommands).catch(toastErr); } },
      ],
    })));
  }
  const groups = new Map();
  for (const c of d.detected) {
    const k = c.source + (c.cwd ? ' — ' + c.cwd + '/' : '');
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(c);
  }
  const s2 = section('detected', 'Détectées', d.detected.length, [], CMDS.collapsed);
  box.appendChild(s2.head);
  if (s2.col) return;
  if (!d.detected.length) box.appendChild(h('div', { class: 'empty small', style: { padding: '4px 20px' }, text: 'Aucun fichier de build reconnu (package.json, composer.json, Makefile, Cargo.toml, go.mod, pubspec.yaml, pom.xml, docker-compose…).' }));
  for (const [k, list] of groups) {
    const col = CMDS.collapsed.has('g:' + k);
    box.appendChild(h('div', { class: 'task-head', style: { cursor: 'pointer', paddingLeft: '20px' }, onclick: () => { col ? CMDS.collapsed.delete('g:' + k) : CMDS.collapsed.add('g:' + k); drawCommands(); }, text: (col ? '▸ ' : '▾ ') + k }));
    if (col) continue;
    for (const c of list) box.appendChild(cmdRow(c, { acts: [{ icon: 'star', title: 'Enregistrer cette commande', action: () => saveCmd({ name: c.name, command: c.command, cwd: c.cwd }) }] }));
  }
}

function cmdRow(c, { acts }) {
  const run = runningFor(c.command);
  return h('div', { class: 'row cmd-row', style: { paddingLeft: '20px' }, title: (c.cwd ? c.cwd + '/ $ ' : '$ ') + c.command, onclick: (e) => { if (!e.target.closest('.acts')) runCommand(c); } },
    h('span', { class: 'icon-btn', style: { color: run ? 'var(--blue)' : 'var(--green)' }, html: icon('play') }),
    h('span', { class: 'txt' }, h('span', { text: c.name }), c.name !== c.command ? h('span', { class: 'cmd-line', text: (c.cwd ? c.cwd + '/ ' : '') + c.command }) : c.cwd ? h('span', { class: 'cmd-line', text: c.cwd + '/' }) : null),
    run ? h('span', { class: 'dot run', title: 'En cours' }) : null,
    h('span', { class: 'acts' }, ...acts.filter(Boolean).map((a) => h('button', { class: 'icon-btn', title: a.title, html: icon(a.icon), onclick: (e) => { e.stopPropagation(); a.action(); } }))));
}

function cmdForm(f) {
  const name = h('input', { class: 'input', value: f.name || '', placeholder: 'Nom (ex. Build prod)' });
  const command = h('input', { class: 'input', value: f.command || '', placeholder: 'Ligne de commande (ex. npm run build && npm run deploy)', spellcheck: 'false', style: { fontFamily: 'var(--mono)', fontSize: '12px' } });
  const cwd = h('input', { class: 'input', value: f.cwd || '', placeholder: 'Sous-dossier (vide = racine du projet)', spellcheck: 'false', list: 'cwd-list' });
  const dl = h('datalist', { id: 'cwd-list' });
  (W().dirs && W().dirs.get('') || []).filter((e) => e.dir).forEach((e) => dl.appendChild(h('option', { value: e.name })));
  const save = () => {
    if (!command.value.trim()) { command.focus(); return; }
    saveCmd({ id: f.id, name: name.value, command: command.value, cwd: cwd.value });
  };
  const box = h('div', { class: 'cmd-form' },
    h('div', { class: 'field' }, name), h('div', { class: 'field' }, command), h('div', { class: 'field' }, cwd, dl),
    h('div', { class: 'btn-row' }, h('button', { class: 'btn secondary', text: 'Annuler', onclick: () => { CMDS.form = null; drawCommands(); } }), h('button', { class: 'btn', text: f.id ? 'Enregistrer' : 'Ajouter', onclick: save })));
  box.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); save(); } if (e.key === 'Escape') { CMDS.form = null; drawCommands(); } });
  setTimeout(() => (f.name ? command : name).focus());
  return box;
}

async function saveCmd(c) {
  try {
    await api('cmds.save', { p: S.pid, cmd: c });
    CMDS.form = null;
    toast('Commande enregistrée', 'ok', 1500);
    refreshCommands();
  } catch (e) { toastErr(e); }
}

// ================================================================ projects
function renderProjects() {
  sideHead('Projets', [
    { icon: 'newfolder', title: 'Ajouter un dossier', action: () => runCmd('project.add') },
    { icon: 'git', title: 'Cloner un dépôt', action: () => runCmd('project.clone') },
    { icon: 'refresh', title: 'Actualiser', action: async () => { await loadState(); renderProjects(); } },
  ]);
  const body = $('.side-body');
  body.innerHTML = '';
  body.appendChild(h('div', { class: 'pad btn-row' },
    h('button', { class: 'btn', html: icon('newfolder') + 'Ajouter', onclick: () => runCmd('project.add') }),
    h('button', { class: 'btn secondary', html: icon('git') + 'Cloner', onclick: () => runCmd('project.clone') })));
  if (!S.projects.length) body.appendChild(h('div', { class: 'empty', text: 'Aucun projet. Ajoutez un dossier existant (site web, appli mobile, API, scripts…) ou clonez un dépôt git.' }));
  S.projects.forEach((p, i) => {
    const row = h('div', { class: 'row proj-row' + (p.id === S.pid ? ' active sel' : ''), title: p.path, onclick: (e) => { if (!e.target.closest('.acts')) activateProject(p.id); } },
      h('span', { class: 'ficon', style: { color: p.id === S.pid ? '#fff' : '#c09553' }, html: icon(p.git ? 'git' : 'folder') }),
      h('span', { class: 'txt' }, h('span', { class: 'n', text: p.name }), h('span', { class: 'p', text: p.path }), p.missing ? h('span', { class: 'warn', text: '⚠ dossier introuvable' }) : null),
      h('span', { class: 'acts' },
        h('button', { class: 'icon-btn', title: 'Renommer', html: icon('edit'), onclick: () => renameProject(p) }),
        i > 0 ? h('button', { class: 'icon-btn', title: 'Monter', html: icon('arrowUp'), onclick: () => moveProject(p, -1) }) : null,
        i < S.projects.length - 1 ? h('button', { class: 'icon-btn', title: 'Descendre', html: icon('arrowDown'), onclick: () => moveProject(p, 1) }) : null,
        h('button', { class: 'icon-btn', title: 'Retirer de la liste', html: icon('close'), onclick: () => removeProject(p) })));
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      ctxMenu(e.clientX, e.clientY, [
        { label: 'Ouvrir', action: () => activateProject(p.id) },
        { label: 'Renommer…', action: () => renameProject(p) },
        { label: 'Copier le chemin', action: () => copyText(p.path) },
        '-',
        { label: 'Retirer de la liste', danger: true, action: () => removeProject(p) },
      ]);
    });
    body.appendChild(row);
  });
  body.appendChild(h('div', { class: 'pad small muted', style: { marginTop: '12px' } },
    h('div', { text: 'Configuration : ' + S.app.dataDir, style: { wordBreak: 'break-all', userSelect: 'text' } }),
    h('a', { href: '#', text: 'Ouvrir le dossier de configuration', onclick: (e) => { e.preventDefault(); api('os.openFolder', { which: 'data' }).catch(toastErr); } })));
}

async function renameProject(p) {
  const v = await prompt('Renommer le projet', { value: p.name });
  if (!v) return;
  await api('project.update', { id: p.id, name: v }).catch(toastErr);
  await loadState();
  renderSidebar();
  window.renderTitle && window.renderTitle();
}
async function moveProject(p, d) { await api('project.move', { id: p.id, delta: d }).catch(toastErr); await loadState(); renderProjects(); }
async function removeProject(p) {
  const ok = await confirmBox('Retirer le projet', `Retirer « ${p.name} » de la liste ? Les fichiers ne sont pas supprimés. Les sessions en cours de ce projet seront arrêtées.`, { ok: 'Retirer' });
  if (!ok) return;
  const w = S.ws.get(p.id);
  if (w && w.tabs.some(isDirty) && !(await confirmBox('Modifications non enregistrées', 'Ce projet a des fichiers non enregistrés. Les abandonner ?', { ok: 'Abandonner', danger: true }))) return;
  await api('project.remove', { id: p.id }).catch(toastErr);
  S.ws.delete(p.id);
  for (const [id, s] of S.sessions) if (s.info.project === p.id) S.sessions.delete(id);
  await loadState();
  const next = S.projects.find((x) => x.id === S.app.active) || S.projects[0];
  if (p.id === S.pid || !next) await activateProject(next ? next.id : null);
  else renderProjects();
}

// ---------------------------------------------------------------- folder picker
async function pickFolder({ title = 'Choisir un dossier', start = '', okLabel = 'Choisir ce dossier' } = {}) {
  let cur = null;
  const pathInput = h('input', { class: 'input', spellcheck: 'false', 'data-noenter': '1', title: 'Entrée pour ouvrir ce chemin' });
  const list = h('div', { class: 'picker-list', tabindex: '0' });
  const roots = h('div', { class: 'picker-roots' });
  const info = h('div', { class: 'small muted', style: { marginTop: '6px' } });
  let selIdx = -1;
  const load = async (p) => {
    try {
      cur = await api('fs.browse', { path: p });
    } catch (e) { toastErr(e); return; }
    pathInput.value = cur.path;
    selIdx = -1;
    list.innerHTML = '';
    if (cur.parent) list.appendChild(h('div', { class: 'row', html: icon('folder') + '<span class="name">..</span>', ondblclick: () => load(cur.parent), onclick: () => load(cur.parent) }));
    cur.dirs.filter((d) => !d.startsWith('.') || d === '.config').forEach((d) => {
      list.appendChild(h('div', { class: 'row', 'data-name': d, html: `<span class="ficon" style="color:#c09553">${icon('folder')}</span><span class="name">${esc(d)}</span>`, onclick: () => load(cur.path.replace(/[\\/]$/, '') + S.app.sep + d) }));
    });
    if (!cur.dirs.length) list.appendChild(h('div', { class: 'empty small', text: 'Aucun sous-dossier.' }));
    info.textContent = cur.git ? '✓ Ce dossier est un dépôt git.' : '';
    roots.innerHTML = '';
    roots.appendChild(h('button', { class: 'chip', text: '🏠 Dossier personnel', onclick: () => load(cur.home) }));
    for (const r of cur.roots) roots.appendChild(h('button', { class: 'chip', text: r, onclick: () => load(r) }));
  };
  pathInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); load(pathInput.value); } });
  const body = h('div', null, h('div', { class: 'picker-path' }, pathInput, h('button', { class: 'btn secondary', text: 'Aller', onclick: () => load(pathInput.value) })), roots, list, info);
  const v = modal({
    title, wide: true, body,
    buttons: [{ label: 'Annuler', kind: 'secondary', value: null }, { label: okLabel, primary: true, value: () => (cur ? cur.path : null) }],
  });
  await load(start || '');
  return v;
}

async function addProjectFlow() {
  const path = await pickFolder({ title: 'Ajouter un dossier comme projet', okLabel: 'Ajouter ce dossier' });
  if (!path) return;
  try {
    const r = await api('project.add', { path });
    await loadState();
    await activateProject(r.id);
    toast('Projet ajouté : ' + P().name, 'ok', 2000);
  } catch (e) { toastErr(e); }
}

async function cloneFlow() {
  const url = h('input', { class: 'input', placeholder: 'https://github.com/moi/projet.git ou git@github.com:moi/projet.git', spellcheck: 'false' });
  const parent = h('input', { class: 'input', value: setting('cloneParent', S.app.home), spellcheck: 'false' });
  const name = h('input', { class: 'input', placeholder: 'automatique', spellcheck: 'false' });
  url.addEventListener('input', () => {
    const m = url.value.trim().replace(/\/+$/, '').match(/([^/:]+?)(\.git)?$/);
    name.placeholder = m ? m[1] : 'automatique';
  });
  const body = h('div', null,
    h('div', { class: 'field' }, h('label', { text: 'URL du dépôt' }), url),
    h('div', { class: 'field' }, h('label', { text: 'Dossier parent' }), h('div', { class: 'picker-path' }, parent, h('button', { class: 'btn secondary', text: 'Parcourir…', onclick: async () => { const p = await pickFolder({ title: 'Dossier parent du clone', start: parent.value }); if (p) parent.value = p; } }))),
    h('div', { class: 'field' }, h('label', { text: 'Nom du dossier' }), name, h('div', { class: 'hint', text: "Le dépôt est cloné puis ajouté comme projet. L'authentification utilise votre configuration git." })));
  const v = await modal({ title: 'Cloner un dépôt git', wide: true, body,
    buttons: [{ label: 'Annuler', kind: 'secondary', value: null }, { label: 'Cloner', primary: true, value: () => ({ url: url.value.trim(), parent: parent.value.trim(), name: name.value.trim() }), validate: () => !!url.value.trim() }] });
  if (!v) return;
  setSetting('cloneParent', v.parent);
  const t = toast('Clonage de ' + v.url + '…', '', 0);
  try {
    const r = await api('project.clone', v);
    t.remove();
    await loadState();
    await activateProject(r.id);
    toast('Dépôt cloné : ' + P().name, 'ok');
  } catch (e) { t.remove(); showOutput('Échec du clonage', e.message, false); }
}

function openTerminalAt(dir) {
  showPanel(true);
  window.termExec && window.termExec('cd "' + (dir ? fullPath(dir) : P().path) + '"', true);
}
