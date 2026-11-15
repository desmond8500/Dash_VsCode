'use strict';
/* global S, W, P, $, $$, h, api, icon, esc, toast, toastErr, modal, prompt, confirmBox, showOutput, ctxMenu, hideCtx, debounce, quickPick, QP, matchPath, fileIcon, basename, dirname, isMd, setting, setSetting, MOD, VERSION, IS_MAC,
   buildEditor, renderTabs, renderEditor, activeTab, openFile, saveTab, saveAll, closeTab, isDirty, setMdMode, checkDisk, cursorInfo, revealLine, langOf, storeEditorState, loadTab, ED,
   buildActivity, showView, renderSidebar, currentView, refreshGit, refreshTasks, refreshExplorer, refreshCommands, addProjectFlow, cloneFlow, branchPicker, createBranch, gitOp, setRemote, newEntry, setBadge,
   loadSessions, showPanel, renderSessions, newTerminal, runCommand, connectEvents, setupTerminalInput, sessionsOf, currentSession, clearSession, renderPrompt, todoFile */

// ---------------------------------------------------------------- state & workspaces
async function loadState() {
  S.app = await api('state');
  S.projects = S.app.projects;
  S.settings = S.app.settings || {};
}

function newWorkspace(pid) {
  return { pid, tabs: [], active: null, expanded: new Set(), mdModes: {}, view: 'explorer', termHistory: [], loaded: false, git: null, tasks: null, dirs: new Map(), sel: null, mdOnly: false };
}

const saveUI = debounce(() => {
  const w = W();
  if (!w || !w.loaded) return;
  const state = {
    tabs: w.tabs.filter((t) => !t.key).map((t) => ({ path: t.path, preview: !!t.preview })),
    active: w.active && !String(w.active).includes(':') ? w.active : (w.tabs.find((t) => !t.key) || {}).path || null,
    expanded: [...w.expanded].slice(0, 500),
    mdModes: w.mdModes,
    view: w.view,
    termHistory: (w.termHistory || []).slice(-200),
    mdOnly: !!w.mdOnly,
  };
  api('ui.save', { id: w.pid, state }).catch(() => {});
}, 700);

async function activateProject(pid) {
  storeEditorState();
  saveUI.flush && saveUI.flush();
  if (!pid || !S.projects.some((p) => p.id === pid)) {
    S.pid = null;
    renderAll();
    return;
  }
  S.pid = pid;
  api('project.activate', { id: pid }).catch(() => {});
  if (!S.ws.has(pid)) S.ws.set(pid, newWorkspace(pid));
  const w = S.ws.get(pid);
  if (!w.loaded) {
    try {
      const st = await api('ui.get', { id: pid });
      w.tabs = (st.tabs || []).map((t) => ({ pid, path: t.path, name: basename(t.path), preview: !!t.preview, loaded: false, mode: isMd(t.path) ? (st.mdModes || {})[t.path] || setting('mdMode', 'edit') : undefined }));
      w.active = st.active && w.tabs.some((t) => t.path === st.active) ? st.active : w.tabs[0] ? w.tabs[0].path : null;
      w.expanded = new Set(st.expanded || []);
      w.mdModes = st.mdModes || {};
      w.view = st.view || 'explorer';
      w.termHistory = st.termHistory || [];
      w.mdOnly = !!st.mdOnly;
    } catch { /* fresh state */ }
    w.loaded = true;
  }
  if (S.pid !== pid) return;
  const t = activeTab();
  if (t && !t.loaded) await loadTab(t);
  if (S.pid !== pid) return;
  renderAll();
  showView(w.view || 'explorer', { focus: false });
  loadSessions(pid);
  refreshGit();
  refreshTasks();
  if (currentView !== 'commands') refreshCommandsQuiet();
}

async function refreshCommandsQuiet() {
  try { CMDS.data = (await api('cmds.list', { p: S.pid }));} catch { /* ignore */ }
}

function renderAll() {
  renderTitle();
  renderTabs();
  renderEditor();
  renderSidebar();
  renderSessions();
  renderPrompt();
  renderStatus();
  if (!S.pid) { setBadge('git', 0); setBadge('tasks', 0); $('#term-out').innerHTML = ''; }
}

function renderTitle() {
  const p = P();
  $('.tb-project-name').textContent = p ? p.name : 'Aucun projet';
  $('.cc-text').textContent = p ? p.name : 'Dash Lite';
  document.title = (activeTab() ? activeTab().name + ' — ' : '') + (p ? p.name + ' — ' : '') + 'Dash Lite';
}

// ---------------------------------------------------------------- status bar
function renderStatus() {
  const sb = $('#statusbar');
  const L = $('.sb-left', sb);
  const R = $('.sb-right', sb);
  L.innerHTML = '';
  R.innerHTML = '';
  sb.classList.toggle('no-folder', !P());
  const item = (parent, html, title, fn) => parent.appendChild(h('div', { class: 'sb-item' + (fn ? '' : ' static'), title: title || '', html, onclick: fn || null }));
  if (!S.connected) item(L, icon('power') + ' Déconnecté', 'Le serveur Dash Lite ne répond plus. Relancez l’application.', null);
  const w = W();
  if (w && w.git && w.git.repo) {
    const g = w.git;
    const dirty = g.files.length ? '*' : '';
    item(L, icon('branch') + esc((g.detached ? 'détachée' : g.branch) + dirty), 'Branche — cliquer pour changer', branchPicker);
    item(L, icon('sync') + (g.behind ? ` ${g.behind}↓` : '') + (g.ahead ? ` ${g.ahead}↑` : ''), g.upstream ? `Synchroniser avec ${g.upstream}` : 'Publier la branche', () => gitOp(g.upstream ? 'git.sync' : 'git.push', {}, { title: g.upstream ? 'Synchronisation' : 'Publication' }));
  }
  if (P()) {
    const running = sessionsOf(S.pid).filter((s) => s.info.running).length;
    if (running) item(L, icon('play') + ' ' + running + ' en cours', 'Processus en cours — afficher le terminal', () => showPanel(true));
    if (w && w.tasks) {
      const done = w.tasks.filter((t) => t.done).length;
      if (w.tasks.length) item(L, icon('checkbox') + ` ${done}/${w.tasks.length}`, 'Tâches terminées / total', () => showView('tasks'));
    }
  }
  const t = activeTab();
  if (t && t.kind === 'text') {
    const c = cursorInfo();
    if (c) item(R, `Ln ${c.ln}, Col ${c.col}${c.selLen ? ` (${c.selLen} sél.)` : ''}`, 'Aller à la ligne (Ctrl+G)', goToLine);
    item(R, t.indent === '\t' ? 'Tabulations' : 'Espaces : ' + (t.indent || '    ').length, "Indentation détectée", () => {
      quickPick({ placeholder: "Indentation de ce fichier", items: [['  ', 'Espaces : 2'], ['    ', 'Espaces : 4'], ['\t', 'Tabulations']].map(([v, l]) => ({ label: l, run: () => { t.indent = v; renderEditor(); } })) });
    });
    item(R, t.encoding === 'latin1' ? 'Latin-1' : t.bom ? 'UTF-8 BOM' : 'UTF-8', 'Encodage', null);
    item(R, t.eol === 'crlf' ? 'CRLF' : 'LF', 'Fins de ligne — cliquer pour changer', () => { t.eol = t.eol === 'crlf' ? 'lf' : 'crlf'; t.saved = null; renderTabs(); renderStatus(); });
    item(R, langOf(t.path), null, null);
  }
  if (P()) {
    item(R, setting('wrap', false) ? icon('wrap') + ' Retour ligne' : icon('wrap'), 'Retour à la ligne automatique (Alt+Z)', toggleWrap);
    item(R, setting('autosave', false) ? icon('check') + ' Enreg. auto' : 'Enreg. auto : non', 'Enregistrement automatique — cliquer pour basculer', toggleAutosave);
  }
  updateStatusItem(L, item);
  item(R, icon('bell'), 'Dash Lite ' + VERSION, () => runCmd('app.about'));
}

function toggleWrap() { storeEditorState(); setSetting('wrap', !setting('wrap', false)); renderEditor(); }
function toggleAutosave() {
  const v = !setting('autosave', false);
  setSetting('autosave', v);
  toast(v ? 'Enregistrement automatique activé' : 'Enregistrement automatique désactivé', 'ok', 1500);
  renderStatus();
}

async function goToLine() {
  const t = activeTab();
  if (!t || t.kind !== 'text') return;
  const n = t.content.split('\n').length;
  const v = await prompt('Aller à la ligne', { placeholder: `1 – ${n}`, label: 'Numéro de ligne (ligne:colonne accepté)' });
  if (!v) return;
  const [l, c] = v.split(':').map((x) => parseInt(x, 10));
  if (l) revealLine(t, l, c ? c - 1 : 0);
}

// ---------------------------------------------------------------- quick open / palette
let fileListCache = { pid: null, at: 0, files: [] };
async function projectFiles() {
  if (fileListCache.pid === S.pid && Date.now() - fileListCache.at < 15000) return fileListCache.files;
  const files = await api('fs.files', { p: S.pid });
  fileListCache = { pid: S.pid, at: Date.now(), files };
  return files;
}

function quickOpen(prefix = '') {
  if (!P()) { runCmd('project.add'); return; }
  const recent = () => W().tabs.filter((t) => !t.key).map((t) => t.path);
  const toItem = (path) => {
    const base = basename(path);
    const off = path.length - base.length;
    return { label: base, desc: dirname(path), icon: fileIcon(base), filter: path, path, labelIdx: (m) => m.idx.filter((i) => i >= off).map((i) => i - off), run: () => openFile(path, { preview: false }) };
  };
  const src = async (q) => {
    if (q.startsWith('>')) return { redirect: () => palette(q.slice(1)) };
    if (q.startsWith(':')) return { redirect: () => { const n = parseInt(q.slice(1), 10); const t = activeTab(); if (n && t) revealLine(t, n); else goToLine(); } };
    if (!q) {
      const r = recent();
      const items = r.length ? [{ sep: true, label: 'Ouverts récemment' }, ...r.map(toItem)] : [];
      items.emptyText = 'Tapez un nom de fichier';
      return items;
    }
    const files = await projectFiles();
    return files.map(toItem);
  };
  quickPick({ placeholder: 'Rechercher un fichier par son nom (> commandes, : ligne)', value: prefix, source: src, matcher: (q, it) => matchPath(q, it.path) });
}

const COMMANDS = [];
function cmd(id, label, run, kb, when) { COMMANDS.push({ id, label, run, kb, when }); }
function runCmd(id, ...a) { const c = COMMANDS.find((x) => x.id === id); if (c) return c.run(...a); }

function palette(value = '') {
  const items = COMMANDS.filter((c) => !c.when || c.when()).map((c) => ({ label: c.label, kb: c.kb ? c.kb.replace(/Ctrl/g, MOD) : '', run: () => c.run() }));
  quickPick({ placeholder: 'Tapez le nom d’une commande', items, value });
}

function projectSwitcher() {
  const items = S.projects.map((p) => ({ label: p.name, desc: p.path + (p.id === S.pid ? '  (actuel)' : ''), icon: icon(p.git ? 'git' : 'folder'), run: () => activateProject(p.id) }));
  items.push({ sep: true, label: '' }, { label: '+ Ajouter un dossier…', run: addProjectFlow }, { label: '+ Cloner un dépôt git…', run: cloneFlow });
  quickPick({ placeholder: 'Changer de projet', items });
}

async function commandRunner() {
  if (!P()) return;
  let d;
  try { d = await api('cmds.list', { p: S.pid }); } catch (e) { toastErr(e); return; }
  const items = [];
  if (d.saved.length) items.push({ sep: true, label: 'Enregistrées' }, ...d.saved.map((c) => ({ label: c.name, desc: (c.cwd ? c.cwd + '/ ' : '') + c.command, icon: icon('play'), filter: c.name + ' ' + c.command, run: () => runCommand(c) })));
  if (d.detected.length) items.push({ sep: true, label: 'Détectées' }, ...d.detected.map((c) => ({ label: c.name, desc: c.source + (c.cwd ? ' · ' + c.cwd + '/' : '') + ' · ' + c.command, icon: icon('play'), filter: c.name + ' ' + c.command + ' ' + c.source, run: () => runCommand(c) })));
  const src = (q) => {
    const list = items.slice();
    if (q.trim()) list.push({ label: '▶ Exécuter « ' + q.trim() + ' »', filter: q, run: () => runCommand({ command: q.trim() }) });
    list.emptyText = 'Tapez une commande à exécuter';
    return list;
  };
  quickPick({ placeholder: 'Lancer une commande (ou tapez une ligne de commande)', source: src });
}

async function syncAll() {
  const btn = $('#sync-all-btn');
  if (btn.classList.contains('busy')) return;
  btn.classList.add('busy');
  try {
    const res = await api('git.syncAll');
    const body = h('div');
    const counts = { ok: 0, error: 0, skipped: 0 };
    for (const r of res) {
      counts[r.status]++;
      body.appendChild(h('div', { class: 'result-row' }, h('span', { class: 'tag ' + r.status, text: { ok: 'OK', error: 'Erreur', skipped: 'Ignoré' }[r.status] }), h('b', { text: r.name }),
        h('span', { class: 'muted small', style: { flex: 1 }, text: r.status === 'skipped' ? r.output : '' })));
      if (r.status === 'error') body.appendChild(h('pre', { class: 'output', text: r.output }));
    }
    if (!res.length) body.appendChild(h('p', { text: 'Aucun projet.' }));
    if (counts.error) modal({ title: `Synchronisation : ${counts.error} erreur(s)`, wide: true, body, buttons: [{ label: 'Fermer', primary: true, value: true }] });
    else {
      const t = toast(`Synchronisation terminée : ${counts.ok} projet(s) à jour${counts.skipped ? `, ${counts.skipped} ignoré(s)` : ''}.`, 'ok', 6000);
      t.style.cursor = 'pointer';
      t.addEventListener('click', () => modal({ title: 'Synchronisation', wide: true, body, buttons: [{ label: 'Fermer', primary: true, value: true }] }));
    }
    refreshGit();
    refreshExplorer();
    checkDisk();
    refreshTasks();
  } catch (e) { toastErr(e); }
  btn.classList.remove('busy');
}

function settingsDialog() {
  const chk = (k, label, def) => { const c = h('input', { type: 'checkbox' }); c.checked = setting(k, def); c.dataset.k = k; return h('label', { class: 'check field' }, c, label); };
  const sel = (k, label, opts, def) => {
    const s = h('select', { class: 'input', 'data-k': k });
    for (const [v, l] of opts) { const o = h('option', { value: v, text: l }); if (String(setting(k, def)) === String(v)) o.selected = true; s.appendChild(o); }
    return h('div', { class: 'field' }, h('label', { text: label }), s);
  };
  const body = h('div', null,
    chk('autosave', 'Enregistrement automatique (1 s après la dernière frappe)', false),
    chk('wrap', 'Retour à la ligne automatique dans l’éditeur', false),
    chk('syntax', 'Coloration syntaxique', true),
    chk('previewTabs', 'Onglets d’aperçu (un clic simple remplace l’onglet en italique)', true),
    sel('mdMode', 'Mode d’ouverture des fichiers Markdown', [['edit', 'Éditer'], ['split', 'Partagé (éditeur + aperçu)'], ['preview', 'Aperçu']], 'edit'),
    sel('fontSize', 'Taille de police de l’éditeur', [[12, '12'], [13, '13'], [14, '14'], [15, '15'], [16, '16'], [18, '18'], [20, '20']], 14),
    sel('indent', 'Indentation par défaut', [[2, '2 espaces'], [4, '4 espaces']], 4),
    sel('updateMode', 'Mises à jour', [['auto', 'Automatiques (installées en arrière-plan, actives au prochain lancement)'], ['notify', 'Me prévenir seulement'], ['off', 'Désactivées']], 'auto'),
    h('div', { class: 'small muted', style: { marginTop: '12px', userSelect: 'text' } }, 'Configuration enregistrée dans : ' + S.app.dataDir));
  modal({
    title: 'Paramètres', body,
    buttons: [
      { label: 'Ouvrir le dossier de configuration', kind: 'secondary', value: 'folder' },
      { label: 'Enregistrer', primary: true, value: (b) => {
        $$('[data-k]', b).forEach((el) => {
          const k = el.dataset.k;
          let v = el.type === 'checkbox' ? el.checked : el.value;
          if (k === 'fontSize' || k === 'indent') v = parseInt(v, 10);
          setSetting(k, v);
        });
        return 'ok';
      } },
    ],
  }).then((v) => {
    if (v === 'folder') api('os.openFolder', { which: 'data' }).catch(toastErr);
    applySettings();
    storeEditorState();
    renderEditor();
  });
}

function applySettings() {
  document.documentElement.style.setProperty('--editor-size', setting('fontSize', 14) + 'px');
  const lay = setting('layout', {});
  if (lay.side) document.documentElement.style.setProperty('--side-w', lay.side + 'px');
  if (lay.panel) document.documentElement.style.setProperty('--panel-h', lay.panel + 'px');
}

function shortcutsDialog() {
  const rows = [
    ['Ouvrir un fichier', 'Ctrl+P'], ['Palette de commandes', 'Ctrl+Maj+P / F1'], ['Changer de projet', 'Ctrl+R'], ['Lancer une commande', 'Ctrl+Maj+B'],
    ['Enregistrer / tout enregistrer', 'Ctrl+S / Ctrl+Maj+S'], ['Cocher une tâche (Markdown)', 'Ctrl+Entrée'], ['Aperçu Markdown', 'Ctrl+Maj+V'],
    ['Terminal', 'Ctrl+`  (ou Ctrl+J)'], ['Aller à une section', 'Ctrl+Maj+O'], ['Barre latérale', 'Ctrl+B'], ['Explorateur / Recherche / Git / Tâches', 'Ctrl+Maj+E / F / G / X'],
    ['Fermer l’onglet / Nouveau fichier', 'Alt+W / Alt+N'], ['Aller à l’onglet n', 'Alt+1…9'], ['Aller à la ligne', 'Ctrl+G'], ['Retour à la ligne', 'Alt+Z'],
    ['Déplacer la ligne', 'Alt+↑ / Alt+↓'], ['Dupliquer la ligne', 'Ctrl+D'], ['Commenter', 'Ctrl+/'], ['Rechercher dans le fichier', 'Ctrl+F (navigateur)'],
    ['Terminal : arrêter / effacer / compléter', 'Ctrl+C / Ctrl+L / Tab'],
  ];
  modal({ title: 'Raccourcis clavier', body: '<table class="kbd-table">' + rows.map(([a, b]) => `<tr><td>${esc(a)}</td><td><kbd>${esc(b.replace(/Ctrl/g, MOD))}</kbd></td></tr>`).join('') + '</table>', buttons: [{ label: 'Fermer', primary: true, value: true }] });
}

async function quitApp() {
  const dirty = [...S.ws.values()].flatMap((w) => w.tabs.filter(isDirty));
  if (dirty.length && !(await confirmBox('Quitter', `${dirty.length} fichier(s) ne sont pas enregistrés. Quitter quand même ?`, { ok: 'Quitter sans enregistrer', danger: true }))) return;
  const running = [...S.sessions.values()].filter((s) => s.info.running).length;
  if (running && !dirty.length && !(await confirmBox('Quitter', `${running} processus sont en cours et seront arrêtés. Quitter ?`, { ok: 'Quitter', danger: true }))) return;
  window.onbeforeunload = null;
  await api('quit').catch(() => {});
  document.body.innerHTML = '<div style="display:flex;height:100vh;align-items:center;justify-content:center;color:#888;font:14px system-ui">Dash Lite est fermé. Vous pouvez fermer cette fenêtre.</div>';
  setTimeout(() => window.close(), 300);
}

function mainMenu(anchor, fromBottom) {
  const r = anchor.getBoundingClientRect();
  ctxMenu(fromBottom ? r.right + 4 : r.left, fromBottom ? r.top - 300 : r.bottom + 2, [
    { label: 'Ouvrir un fichier…', kb: MOD + '+P', action: () => quickOpen() },
    { label: 'Palette de commandes…', kb: MOD + '+Maj+P', action: () => palette() },
    '-',
    { label: 'Ajouter un dossier comme projet…', action: addProjectFlow },
    { label: 'Cloner un dépôt git…', action: cloneFlow },
    { label: 'Changer de projet…', kb: MOD + '+R', action: projectSwitcher },
    '-',
    { label: 'Nouveau fichier', kb: 'Alt+N', action: () => newEntry(false) },
    { label: 'Enregistrer', kb: MOD + '+S', action: () => saveTab(activeTab()) },
    { label: 'Tout enregistrer', kb: MOD + '+Maj+S', action: saveAll },
    '-',
    { label: 'Paramètres…', action: settingsDialog },
    { label: 'Raccourcis clavier', action: shortcutsDialog },
    { label: 'Rechercher des mises à jour…', action: () => checkForUpdates(false) },
    S.app && S.app.platform === 'linux' ? { label: 'Ajouter au menu des applications', action: () => runCmd('app.shortcut') } : null,
    { label: 'À propos', action: () => runCmd('app.about') },
    '-',
    { label: 'Quitter Dash Lite', danger: true, action: quitApp },
  ]);
}

// ---------------------------------------------------------------- command registry
function registerCommands() {
  const hasP = () => !!P();
  const hasText = () => { const t = activeTab(); return t && t.kind === 'text'; };
  const hasGit = () => W() && W().git && W().git.repo;
  cmd('file.quickOpen', 'Ouvrir un fichier…', () => quickOpen(), 'Ctrl+P');
  cmd('palette', 'Palette de commandes', () => palette(), 'Ctrl+Maj+P');
  cmd('project.switch', 'Projets : changer de projet…', projectSwitcher, 'Ctrl+R');
  cmd('project.add', 'Projets : ajouter un dossier…', addProjectFlow);
  cmd('project.clone', 'Projets : cloner un dépôt git…', cloneFlow);
  cmd('file.new', 'Fichier : nouveau fichier…', () => newEntry(false), 'Alt+N', hasP);
  cmd('file.newFolder', 'Fichier : nouveau dossier…', () => newEntry(true), '', hasP);
  cmd('file.save', 'Fichier : enregistrer', () => saveTab(activeTab()), 'Ctrl+S', hasText);
  cmd('file.saveAll', 'Fichier : tout enregistrer', saveAll, 'Ctrl+Maj+S', hasP);
  cmd('file.close', 'Fichier : fermer l’onglet', () => { const t = activeTab(); t && closeTab(t); }, 'Alt+W', () => !!activeTab());
  cmd('file.closeAll', 'Fichier : fermer tous les onglets', () => window.closeTabs(W().tabs), '', hasP);
  cmd('file.reveal', 'Fichier : afficher dans le dossier système', () => { const t = activeTab(); t && api('os.reveal', { p: S.pid, path: t.path }).catch(toastErr); }, '', () => activeTab() && !activeTab().key);
  cmd('editor.goToLine', 'Éditeur : aller à la ligne…', goToLine, 'Ctrl+G', hasText);
  cmd('editor.wrap', 'Éditeur : retour à la ligne automatique', toggleWrap, 'Alt+Z');
  cmd('editor.autosave', 'Éditeur : activer/désactiver l’enregistrement automatique', toggleAutosave);
  cmd('md.preview', 'Markdown : basculer l’aperçu', () => { const t = activeTab(); if (t && isMd(t.path)) setMdMode(t, t.mode === 'preview' ? 'edit' : 'preview'); }, 'Ctrl+Maj+V', () => hasText() && isMd(activeTab().path));
  cmd('md.split', 'Markdown : éditeur + aperçu côte à côte', () => { const t = activeTab(); if (t && isMd(t.path)) setMdMode(t, t.mode === 'split' ? 'edit' : 'split'); }, '', () => hasText() && isMd(activeTab().path));
  cmd('view.explorer', 'Affichage : explorateur', () => showView('explorer'), 'Ctrl+Maj+E');
  cmd('view.search', 'Affichage : rechercher dans le projet', () => showView('search'), 'Ctrl+Maj+F');
  cmd('view.git', 'Affichage : git', () => showView('git'), 'Ctrl+Maj+G');
  cmd('view.tasks', 'Affichage : tâches', () => showView('tasks'), 'Ctrl+Maj+X');
  cmd('view.commands', 'Affichage : commandes', () => showView('commands'));
  cmd('view.projects', 'Affichage : projets', () => showView('projects'));
  cmd('view.sidebar', 'Affichage : afficher/masquer la barre latérale', () => document.body.classList.toggle('no-side'), 'Ctrl+B');
  cmd('panel.toggle', 'Terminal : afficher/masquer', () => showPanel(), 'Ctrl+`');
  cmd('terminal.new', 'Terminal : nouveau terminal', newTerminal, '', hasP);
  cmd('terminal.clear', 'Terminal : effacer', clearSession, 'Ctrl+L', hasP);
  cmd('run.command', 'Commandes : lancer une commande…', commandRunner, 'Ctrl+Maj+B', hasP);
  cmd('tasks.add', 'Tâches : ajouter une tâche…', async () => {
    const v = await prompt('Nouvelle tâche', { label: 'Ajoutée à ' + todoFile() });
    if (v && v.trim()) { await api('tasks.add', { p: S.pid, file: todoFile(), text: v }).catch(toastErr); const t = window.findTab(todoFile()); if (t && t.loaded && !isDirty(t)) window.reloadTab(t); refreshTasks(); }
  }, '', hasP);
  cmd('sections.goto', 'Sections : aller à une section…', sectionPicker, 'Ctrl+Maj+O', () => !!mdTab());
  cmd('view.sections', 'Affichage : sections du fichier', () => showView('sections'));
  cmd('sections.add', 'Sections : nouvelle section…', () => { const t = mdTab(); if (t && isMd(t.path)) addSection(t, { level: 2 }); }, '', () => !!mdTab());
  cmd('sections.task', 'Sections : ajouter une tâche dans la section courante…', () => {
    const t = mdTab(); if (!t) return; const { list } = parseSections(t.content); addTaskToSection(t, list[currentSectionIndex(list)] || null);
  }, '', () => !!mdTab());
  cmd('tasks.open', 'Tâches : ouvrir le fichier des tâches', () => openFile(todoFile(), { preview: false }), '', hasP);
  cmd('git.commit', 'Git : commit', () => { showView('git'); setTimeout(() => $('.git-msg-input') && $('.git-msg-input').focus(), 100); }, '', hasGit);
  cmd('git.pull', 'Git : pull', () => gitOp('git.pull', {}, { title: 'Pull' }), '', hasGit);
  cmd('git.push', 'Git : push', () => gitOp('git.push', {}, { title: 'Push' }), '', hasGit);
  cmd('git.sync', 'Git : synchroniser (pull + push)', () => gitOp('git.sync', {}, { title: 'Synchronisation' }), '', hasGit);
  cmd('git.fetch', 'Git : fetch', () => gitOp('git.fetch', {}, { title: 'Fetch' }), '', hasGit);
  cmd('git.checkout', 'Git : changer de branche…', branchPicker, '', hasGit);
  cmd('git.branch', 'Git : créer une branche…', createBranch, '', hasGit);
  cmd('git.remote', 'Git : connecter un dépôt distant…', setRemote, '', hasP);
  cmd('git.init', 'Git : initialiser un dépôt', () => gitOp('git.init', {}, { title: 'git init' }), '', () => hasP() && !hasGit());
  cmd('git.syncAll', 'Git : tout synchroniser (tous les projets)', syncAll);
  cmd('app.settings', 'Paramètres…', settingsDialog);
  cmd('app.shortcuts', 'Aide : raccourcis clavier', shortcutsDialog);
  cmd('app.about', 'Aide : à propos de Dash Lite', () => modal({
    title: 'Dash Lite ' + VERSION,
    body: `<p>Éditeur léger multi-projets : fichiers et tâches Markdown, terminal, commandes enregistrées et git.</p><p class="muted small">Un seul exécutable, aucune installation. L'interface s'ouvre dans une fenêtre Chrome/Edge en mode application ; fermer la fenêtre arrête l'application.</p><p class="muted small">Configuration : ${esc(S.app.dataDir)}</p>`,
    buttons: [{ label: 'Mises à jour…', kind: 'secondary', value: 'upd' }, { label: 'Fermer', primary: true, value: true }],
  }).then((v) => { if (v === 'upd') updateDialog(); }));
  cmd('app.update', 'Aide : rechercher des mises à jour', () => checkForUpdates(false));
  cmd('app.shortcut', 'Linux : ajouter Dash Lite au menu des applications', async () => {
    try { const r = await api('os.shortcut'); toast('Raccourci créé : ' + r.path, 'ok', 4000); } catch (e) { toastErr(e); }
  }, '', () => S.app && S.app.platform === 'linux');
  cmd('app.quit', 'Quitter Dash Lite', quitApp);
}

// ---------------------------------------------------------------- keyboard
function setupKeys() {
  window.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const inModal = !!document.querySelector('.modal-back');
    if (e.key === 'Escape') {
      hideCtx();
      if (QP.open) { QP.close(); e.preventDefault(); return; }
      if (document.body.classList.contains('panel-max')) { document.body.classList.remove('panel-max'); renderSessions(); }
    }
    if (inModal || QP.open) return;
    let handled = true;
    if (mod && e.shiftKey && k === 'p') palette();
    else if (e.key === 'F1') palette();
    else if (mod && !e.shiftKey && k === 'p') quickOpen();
    else if (mod && !e.shiftKey && k === 'r') projectSwitcher();
    else if (mod && e.shiftKey && k === 's') saveAll();
    else if (mod && !e.shiftKey && k === 's') saveTab(activeTab());
    else if (mod && e.shiftKey && k === 'v') runCmd('md.preview');
    else if (mod && e.shiftKey && k === 'e') showView('explorer');
    else if (mod && e.shiftKey && k === 'f') showView('search');
    else if (mod && e.shiftKey && k === 'g') showView('git');
    else if (mod && e.shiftKey && k === 'x') showView('tasks');
    else if (mod && e.shiftKey && k === 'b') commandRunner();
    else if (mod && e.shiftKey && k === 'o') sectionPicker();
    else if (mod && !e.shiftKey && k === 'b') document.body.classList.toggle('no-side');
    else if (mod && (e.key === '`' || e.code === 'Backquote' || k === 'j')) showPanel();
    else if (mod && !e.shiftKey && k === 'g') goToLine();
    else if (e.altKey && !mod && k === 'w') runCmd('file.close');
    else if (e.altKey && !mod && k === 'n') newEntry(false);
    else if (e.altKey && !mod && k === 'z') toggleWrap();
    else if (e.altKey && !mod && /^[1-9]$/.test(e.key)) { const t = W() && W().tabs[+e.key - 1]; if (t) window.activateTab(t.key || t.path); }
    else handled = false;
    if (handled) { e.preventDefault(); e.stopPropagation(); }
  }, true);
}

// ---------------------------------------------------------------- layout sashes
function setupSashes() {
  const drag = (sash, onMove) => {
    sash.addEventListener('mousedown', (e) => {
      e.preventDefault();
      sash.classList.add('drag');
      const move = (ev) => onMove(ev);
      const up = () => {
        sash.classList.remove('drag');
        removeEventListener('mousemove', move);
        removeEventListener('mouseup', up);
        const side = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--side-w'), 10);
        const panel = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--panel-h'), 10);
        setSetting('layout', { side, panel });
      };
      addEventListener('mousemove', move);
      addEventListener('mouseup', up);
    });
  };
  drag($('#sash-side'), (e) => {
    const w = Math.max(170, Math.min(innerWidth - 300, e.clientX - 48));
    document.documentElement.style.setProperty('--side-w', w + 'px');
  });
  drag($('#sash-panel'), (e) => {
    const hgt = Math.max(90, Math.min(innerHeight - 160, innerHeight - 22 - e.clientY));
    document.documentElement.style.setProperty('--panel-h', hgt + 'px');
  });
}

// ---------------------------------------------------------------- init
async function init() {
  $('#menu-btn').innerHTML = icon('menu');
  $('.chev').innerHTML = icon('down');
  $('.cc-icon').innerHTML = icon('search');
  $('#sync-all-btn .ico').innerHTML = icon('sync');
  $('#menu-btn').addEventListener('click', (e) => mainMenu(e.currentTarget));
  $('#project-btn').addEventListener('click', projectSwitcher);
  $('#command-center').addEventListener('click', () => quickOpen());
  $('#sync-all-btn').addEventListener('click', syncAll);
  buildActivity();
  buildEditor();
  registerCommands();
  setupKeys();
  setupSashes();
  setupTerminalInput();
  try { await loadState(); } catch (e) { toastErr(e); return; }
  applySettings();
  if (!setting('panelOpen', true)) document.body.classList.add('no-panel');
  connectEvents();
  api('update.status').then(handleUpdate).catch(() => {});
  const first = S.projects.find((p) => p.id === S.app.active) || S.projects[0];
  await activateProject(first ? first.id : null);
  if (!first) showView('projects');

  window.addEventListener('focus', () => {
    if (!S.pid) return;
    checkDisk();
    refreshGitSoonFocus();
    if (currentView === 'explorer') refreshExplorer();
  });
  setInterval(checkDisk, 4000);
  setInterval(() => { if (document.visibilityState === 'visible' && S.pid) refreshGit(); }, 20000);
  window.onbeforeunload = (e) => {
    const dirty = [...S.ws.values()].some((w) => w.tabs.some(isDirty));
    if (dirty) { e.preventDefault(); e.returnValue = ''; return ''; }
  };
  document.addEventListener('contextmenu', (e) => {
    // keep the native menu only where it helps (text fields, editor, output)
    if (!e.target.closest('textarea, input, .preview, #term-out, .diff-view, .modal-body, pre')) e.preventDefault();
  });
}
const refreshGitSoonFocus = debounce(() => { refreshGit(); refreshTasks(); }, 300);

init();
