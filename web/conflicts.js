'use strict';
/* global S, W, $, $$, h, api, icon, esc, toast, toastErr, confirmBox, activeTab, isDirty, saveTab, setTabContent, insertText, revealLine, ED, setting, showView, refreshGit, gitOp, currentView */

// ================================================================ conflict markers in the editor
//   <<<<<<< HEAD            ← "current" side (HEAD)
//   …
//   ||||||| base            (optional, diff3 style)
//   =======
//   …                       ← "incoming" side
//   >>>>>>> branch
const shortLabel = (l) => (/^[0-9a-f]{40}$/.test(l) ? l.slice(0, 7) + ' (distante)' : l);
function parseConflicts(text) {
  const lines = text.split('\n');
  const regions = [];
  let cur = null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].replace(/\r$/, '');
    if (/^<{7}(?: |$)/.test(l)) cur = { start: i, base: -1, sep: -1, end: -1, curLabel: shortLabel(l.slice(8).trim()) || 'HEAD' };
    else if (cur && cur.sep < 0 && /^\|{7}(?: |$)/.test(l)) cur.base = i;
    else if (cur && cur.sep < 0 && /^={7}$/.test(l)) cur.sep = i;
    else if (cur && cur.sep >= 0 && /^>{7}(?: |$)/.test(l)) {
      cur.end = i;
      cur.incLabel = shortLabel(l.slice(8).trim()) || 'entrante';
      regions.push(cur);
      cur = null;
    }
  }
  return { lines, regions };
}

function regionParts(lines, r) {
  return {
    current: lines.slice(r.start + 1, r.base >= 0 ? r.base : r.sep),
    incoming: lines.slice(r.sep + 1, r.end),
  };
}

function chosenLines(lines, r, which) {
  const p = regionParts(lines, r);
  if (which === 'current') return p.current;
  if (which === 'incoming') return p.incoming;
  if (which === 'both') return p.current.concat(p.incoming);
  return [];
}

// replace one or all regions; through the editor when visible so Ctrl+Z works
function resolveRegions(t, picks) {
  const { lines, regions } = parseConflicts(t.content);
  const out = [];
  let i = 0;
  let firstLine = null;
  regions.forEach((r, k) => {
    const which = typeof picks === 'string' ? picks : picks[k];
    out.push(...lines.slice(i, r.start));
    if (!which) { out.push(...lines.slice(r.start, r.end + 1)); i = r.end + 1; return; }
    if (firstLine == null) firstLine = out.length;
    out.push(...chosenLines(lines, r, which));
    i = r.end + 1;
  });
  out.push(...lines.slice(i));
  const text = out.join('\n');
  if (activeTab() === t && !ED.wrap.hidden) {
    const sc = ED.ta.scrollTop;
    ED.ta.focus();
    ED.ta.setSelectionRange(0, ED.ta.value.length);
    insertText(text);
    ED.ta.scrollTop = sc;
    if (firstLine != null) {
      let off = 0;
      for (let k = 0; k < firstLine; k++) off += out[k].length + 1;
      ED.ta.setSelectionRange(off, off);
    }
  } else setTabContent(t, text);
  renderConflicts();
}

function resolveOne(t, index, which) {
  const picks = [];
  picks[index] = which;
  resolveRegions(t, picks);
}

function gotoConflict(t, dir) {
  const { regions } = parseConflicts(t.content);
  if (!regions.length) return;
  const ln = ED.ta.value.slice(0, ED.ta.selectionStart).split('\n').length - 1;
  let r;
  if (dir > 0) r = regions.find((x) => x.start > ln) || regions[0];
  else r = [...regions].reverse().find((x) => x.start < ln) || regions[regions.length - 1];
  revealLine(t, r.start + 1);
}

function fileInConflict(t) {
  const g = W() && W().git;
  return !!(g && g.files.some((f) => f.conflict && f.path === t.path));
}

// ---------------------------------------------------------------- overlay + bar
const CFX = { text: null, parsed: null };
function conflictsOf(t) {
  if (CFX.text !== t.content) { CFX.text = t.content; CFX.parsed = parseConflicts(t.content); }
  return CFX.parsed;
}

function renderConflicts() {
  const t = activeTab();
  const bar = ED.cbar;
  const bg = ED.cfxBg;
  const btns = ED.cfxBtns;
  bg.innerHTML = '';
  btns.innerHTML = '';
  if (!t || t.kind !== 'text' || ED.cur !== t) { bar.hidden = true; return; }
  const { regions } = conflictsOf(t);
  const op = W() && W().git && W().git.op;
  renderConflictBar(t, regions, op);
  if (!regions.length || ED.wrap.hidden || setting('wrap', false)) return;
  const ta = ED.ta;
  const lh = parseFloat(getComputedStyle(ta).lineHeight) || 21;
  const top = (line) => 8 + line * lh - ta.scrollTop;
  const vis = (a, b) => top(b) > -lh && top(a) < ta.clientHeight + lh;
  regions.forEach((r, k) => {
    if (!vis(r.start, r.end + 1)) return;
    const mid = r.base >= 0 ? r.base : r.sep;
    const band = (cls, a, b) => bg.appendChild(h('div', { class: 'cfx-band ' + cls, style: { top: top(a) + 'px', height: (b - a) * lh + 'px' } }));
    band('cfx-cur-h', r.start, r.start + 1);
    band('cfx-cur', r.start + 1, mid);
    if (r.base >= 0) band('cfx-base', r.base, r.sep);
    band('cfx-sep', r.sep, r.sep + 1);
    band('cfx-inc', r.sep + 1, r.end);
    band('cfx-inc-h', r.end, r.end + 1);
    const b = (label, which, title) => h('button', { class: 'cfx-btn', title, text: label, onmousedown: (e) => e.preventDefault(), onclick: () => resolveOne(t, k, which) });
    btns.appendChild(h('div', { class: 'cfx-actions', style: { top: top(r.start) + 'px', height: lh + 'px' } },
      b('Garder l’actuelle', 'current', `Garder « ${r.curLabel} »`),
      b('Garder l’entrante', 'incoming', `Garder « ${r.incLabel} »`),
      b('Garder les deux', 'both', 'Garder les deux versions, l’actuelle puis l’entrante'),
      b('Aucune', 'none', 'Supprimer les deux versions')));
  });
}

function renderConflictBar(t, regions, op) {
  const bar = ED.cbar;
  bar.innerHTML = '';
  const inGit = fileInConflict(t);
  if (!regions.length && !inGit) { bar.hidden = true; return; }
  bar.hidden = false;
  if (regions.length) {
    const r0 = regions[0];
    bar.append(
      h('span', { class: 'cfx-title', html: icon('git') + `<b>${regions.length} conflit${regions.length > 1 ? 's' : ''}</b>` }),
      h('button', { class: 'icon-btn', title: 'Conflit précédent', html: icon('arrowUp'), onclick: () => gotoConflict(t, -1) }),
      h('button', { class: 'icon-btn', title: 'Conflit suivant', html: icon('arrowDown'), onclick: () => gotoConflict(t, 1) }),
      h('span', { class: 'cfx-legend' }, h('i', { class: 'sw cur' }), `actuelle : ${r0.curLabel}`, h('i', { class: 'sw inc' }), `entrante : ${r0.incLabel}`),
      h('span', { class: 'grow' }),
      h('span', { class: 'muted', text: 'Tout résoudre :' }),
      h('button', { class: 'btn secondary', text: 'Actuelle', title: 'Garder la version actuelle dans tous les conflits de ce fichier', onclick: () => resolveRegions(t, 'current') }),
      h('button', { class: 'btn secondary', text: 'Entrante', title: 'Garder la version entrante dans tous les conflits de ce fichier', onclick: () => resolveRegions(t, 'incoming') }),
      h('button', { class: 'btn secondary', text: 'Les deux', onclick: () => resolveRegions(t, 'both') }));
    if (op === 'rebase') bar.appendChild(h('div', { class: 'cfx-hint', text: 'Rebase : « actuelle » est la branche sur laquelle vous rejouez vos commits (souvent la distante), « entrante » est votre commit.' }));
    if (setting('wrap', false)) bar.appendChild(h('div', { class: 'cfx-hint', text: 'Désactivez le retour à la ligne (Alt+Z) pour afficher les boutons sur chaque conflit.' }));
  } else {
    bar.append(
      h('span', { class: 'cfx-title ok', html: icon('check') + '<b>Plus de marqueurs de conflit dans ce fichier.</b>' }),
      h('span', { class: 'grow' }),
      h('button', { class: 'btn', text: isDirty(t) ? 'Enregistrer et marquer comme résolu' : 'Marquer comme résolu', onclick: () => markResolved([t.path]) }));
  }
}

async function markResolved(paths, force) {
  for (const p of paths) {
    const t = W().tabs.find((x) => !x.key && x.path === p);
    if (t && isDirty(t) && !(await saveTab(t))) return;
  }
  try {
    const r = await api('git.stage', { p: S.pid, paths, force: !!force });
    if (r && r.ok === false) { toast(r.output || 'Échec', 'err'); return; }
    toast(paths.length > 1 ? `${paths.length} fichiers marqués comme résolus` : 'Conflit résolu : fichier indexé', 'ok', 2000);
  } catch (e) {
    if (e.status === 409 && e.message.startsWith('MARKERS:')) {
      const files = e.message.slice(8).split('\n');
      const ok = await confirmBox('Marqueurs de conflit restants', `${files.join(', ')} contient encore des marqueurs <<<<<<< / >>>>>>>. Marquer quand même comme résolu ?`, { ok: 'Marquer quand même', danger: true });
      if (ok) return markResolved(paths, true);
      return;
    }
    toastErr(e);
  }
  await refreshGit();
  renderConflicts();
}

// ================================================================ git view parts
const OP_LABEL = { merge: 'Fusion en cours', rebase: 'Rebase en cours', 'cherry-pick': 'Cherry-pick en cours', revert: 'Revert en cours' };

function gitOperationBox(g) {
  if (!g.op) return null;
  const done = !g.conflicts;
  return h('div', { class: 'git-op' + (done ? ' ready' : '') },
    h('div', { class: 'git-op-title', html: icon('git') + '<b>' + OP_LABEL[g.op] + '</b>' }),
    g.opInfo ? h('div', { class: 'small muted', text: g.opInfo }) : null,
    h('div', { class: 'small', style: { margin: '4px 0 6px' }, text: done
      ? 'Tous les conflits sont résolus. Vous pouvez terminer.'
      : `${g.conflicts} fichier${g.conflicts > 1 ? 's' : ''} en conflit : ouvrez-les pour choisir les versions, puis marquez-les comme résolus (+).` }),
    h('div', { class: 'btn-row' },
      h('button', { class: 'btn' + (done ? '' : ' secondary'), text: g.op === 'merge' ? 'Terminer la fusion' : 'Continuer', disabled: !done, onclick: continueOperation }),
      h('button', { class: 'btn danger', text: 'Annuler', title: 'Revenir à l’état d’avant (' + g.op + ' --abort)', onclick: abortOperation })));
}

async function continueOperation() {
  const g = W().git;
  const dirty = W().tabs.filter(isDirty);
  for (const t of dirty) await saveTab(t);
  const message = g.op === 'merge' ? (GIT.msg[S.pid] || '').trim() : '';
  const ok = await gitOp('git.continue', { message }, { title: g.op === 'merge' ? 'Fin de la fusion' : 'Suite du ' + g.op });
  if (ok) { GIT.msg[S.pid] = ''; toast(g.op === 'merge' ? 'Fusion terminée.' : 'Opération poursuivie.', 'ok', 2500); }
}

async function abortOperation() {
  const g = W().git;
  const ok = await confirmBox('Annuler', `Annuler ${g.op === 'merge' ? 'la fusion' : 'le ' + g.op} et revenir à l’état d’avant ? Les résolutions déjà faites seront perdues.`, { ok: 'Annuler l’opération', danger: true, cancel: 'Continuer à résoudre' });
  if (ok) await gitOp('git.abort', {}, { title: 'Annulation' });
}

function conflictKind(f) {
  return { UU: 'modifié des deux côtés', AA: 'ajouté des deux côtés', DU: 'supprimé côté actuel', UD: 'supprimé côté entrant', AU: 'ajouté côté actuel', UA: 'ajouté côté entrant', DD: 'supprimé des deux côtés' }[f.x + f.y] || 'en conflit';
}

async function resolveWholeFile(f, side) {
  const label = side === 'current' ? 'actuelle' : 'entrante';
  const ok = await confirmBox('Résoudre le fichier entier', `Remplacer « ${f.path} » par sa version ${label} complète ? Les modifications de l’autre côté dans ce fichier seront ignorées, y compris celles que git avait fusionnées sans conflit. Pour choisir bloc par bloc, ouvrez le fichier.`, { ok: 'Garder la version ' + label });
  if (!ok) return;
  await gitOp('git.resolveFile', { path: f.path, side }, { title: 'Résolution', silent: true });
  const t = W().tabs.find((x) => !x.key && x.path === f.path);
  if (t && t.loaded && !isDirty(t)) window.reloadTab(t);
}
