'use strict';
/* global S, W, P, $, $$, h, api, icon, esc, toast, toastErr, modal, prompt, confirmBox, ctxMenu, debounce, quickPick, isMd, extOf,
   activeTab, isDirty, saveTab, setTabContent, insertText, revealLine, ED, setMdMode, sideHead, currentView, showView, renderSidebar, refreshTasksSoon, MOD */

// ================================================================ parsing
// A section = a heading (#…######, <h1>…<h6> or setext) and everything up to
// the next heading of the same or a higher level.
const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
const ATX = /^(\s{0,3})(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const HTML_H = /^\s*<h([1-6])\b[^>]*>(.*?)<\/h\1>\s*$/i;
const TASK = /^\s*(?:[-*+]|\d+[.)])\s+\[([ xX])\]/;

function parseSections(text) {
  const lines = text.split('\n');
  const list = [];
  let fence = null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const f = l.match(FENCE);
    if (f) {
      if (!fence) fence = f[1][0];
      else if (f[1][0] === fence && l.trim().replace(/[`~]/g, '') === '') fence = null;
      continue;
    }
    if (fence) continue;
    let m = l.match(ATX);
    if (m) { list.push({ level: m[2].length, title: (m[3] || '').trim(), line: i, kind: 'atx' }); continue; }
    m = l.match(HTML_H);
    if (m) { list.push({ level: +m[1], title: m[2].replace(/<[^>]+>/g, '').trim(), line: i, kind: 'html' }); continue; }
    const next = lines[i + 1];
    if (next != null && l.trim() && (i === 0 || !lines[i - 1].trim()) && /^\s{0,3}(=+|-{2,})\s*$/.test(next) &&
        !/^\s*([-*+]|\d+[.)])\s|^\s*>|^\s*\|/.test(l)) {
      list.push({ level: next.trim()[0] === '=' ? 1 : 2, title: l.trim(), line: i, kind: 'setext' });
      i++;
    }
  }
  const stack = [];
  list.forEach((s, k) => {
    s.index = k;
    const nxt = list.slice(k + 1).find((o) => o.level <= s.level);
    s.end = nxt ? nxt.line : lines.length;
    const firstChild = list[k + 1] && list[k + 1].line < s.end ? list[k + 1].line : s.end;
    s.bodyEnd = firstChild; // end of the section's own content (before its subsections)
    while (stack.length && stack[stack.length - 1].level >= s.level) stack.pop();
    s.parent = stack.length ? stack[stack.length - 1] : null;
    s.depth = stack.length;
    stack.push(s);
    let done = 0, total = 0;
    for (let i = s.line; i < s.end; i++) { const t = lines[i].match(TASK); if (t) { total++; if (t[1] !== ' ') done++; } }
    s.done = done;
    s.total = total;
  });
  return { lines, list };
}

function headingText(level, title, kind, original) {
  if (kind === 'html') return original.replace(/<h[1-6]\b/i, '<h' + level).replace(/<\/h[1-6]>/i, '</h' + level + '>');
  return '#'.repeat(level) + (title ? ' ' + title : '');
}

// ================================================================ editing helpers
function mdTab() {
  const t = activeTab();
  return t && t.kind === 'text' && t.loaded && (isMd(t.path) || ['html', 'htm', 'vue', 'php'].includes(extOf(t.path))) ? t : null;
}
const editable = (t) => t && isMd(t.path);

function applyLines(t, lines, caretLine) {
  const wasClean = !isDirty(t);
  const text = lines.join('\n');
  if (activeTab() === t && !ED.wrap.hidden) {
    const sc = ED.ta.scrollTop;
    ED.ta.focus();
    ED.ta.setSelectionRange(0, ED.ta.value.length);
    insertText(text); // keeps Ctrl+Z
    ED.ta.scrollTop = sc;
    if (caretLine != null) revealLine(t, caretLine + 1);
  } else {
    setTabContent(t, text);
    if (caretLine != null && ED.preview && !ED.preview.hidden) {
      const el = ED.md.querySelector(`[data-line="${caretLine}"]`);
      el && el.scrollIntoView({ block: 'start' });
    }
  }
  if (wasClean) saveTab(t);
  refreshTasksSoon();
  drawSections();
}

const trimEnd = (block) => { const b = block.slice(); while (b.length && !b[b.length - 1].trim()) b.pop(); return b; };

// Moves section `s` so that it starts at line `target` with heading level `level` (subtree shifted).
function moveSection(t, s, target, level) {
  const { lines } = parseSections(t.content);
  if (target > s.line && target < s.end) return;
  const delta = level - s.level;
  const block = shiftLevels(lines.slice(s.line, s.end), delta);
  if (!block) { toast('Niveau de titre hors limites (1 à 6).', 'err'); return; }
  const rest = lines.slice(0, s.line).concat(lines.slice(s.end));
  let at = target > s.line ? target - (s.end - s.line) : target;
  let before = rest.slice(0, at);
  const after = rest.slice(at);
  const moved = trimEnd(block);
  // keep one blank line around the moved block
  before = trimEnd(before);
  const out = before.concat(before.length ? [''] : [], moved, after.length ? [''] : [], trimLead(after));
  applyLines(t, out, before.length ? before.length + 1 : 0);
}
function trimLead(arr) { let i = 0; while (i < arr.length && !arr[i].trim()) i++; return arr.slice(i); }

function shiftLevels(block, delta) {
  if (!delta) return block;
  const sub = parseSections(block.join('\n'));
  for (const h of sub.list) if (h.level + delta < 1 || h.level + delta > 6) return null;
  const out = block.slice();
  for (const h of sub.list.slice().reverse()) {
    const lvl = h.level + delta;
    if (h.kind === 'setext') out.splice(h.line, 2, headingText(lvl, h.title, 'atx'));
    else out[h.line] = headingText(lvl, h.title, h.kind, out[h.line]);
  }
  return out;
}

function sectionOps(t, s, all) {
  const siblings = all.filter((o) => o.parent === s.parent && o.level === s.level);
  const i = siblings.indexOf(s);
  return {
    up: i > 0 ? () => moveSection(t, s, siblings[i - 1].line, s.level) : null,
    down: i >= 0 && i < siblings.length - 1 ? () => moveSection(t, s, siblings[i + 1].end, s.level) : null,
    promote: s.level > 1 ? () => changeLevel(t, s, -1) : null,
    demote: s.level < 6 ? () => changeLevel(t, s, 1) : null,
  };
}

function changeLevel(t, s, delta) {
  const { lines } = parseSections(t.content);
  const block = shiftLevels(lines.slice(s.line, s.end), delta);
  if (!block) { toast('Niveau de titre hors limites (1 à 6).', 'err'); return; }
  applyLines(t, lines.slice(0, s.line).concat(block, lines.slice(s.end)), s.line);
}

async function renameSection(t, s) {
  const v = await prompt('Renommer la section', { value: s.title });
  if (v == null || !v.trim()) return;
  const { lines } = parseSections(t.content);
  if (s.kind === 'setext') lines.splice(s.line, 2, headingText(s.level, v.trim(), 'atx'));
  else if (s.kind === 'html') lines[s.line] = lines[s.line].replace(/(<h[1-6]\b[^>]*>).*?(<\/h[1-6]>)/i, (_, a, b) => a + esc(v.trim()) + b);
  else lines[s.line] = lines[s.line].match(ATX)[1] + headingText(s.level, v.trim(), 'atx');
  applyLines(t, lines, s.line);
}

async function deleteSection(t, s) {
  const n = s.end - s.line;
  const sub = parseSections(t.content).list.filter((o) => o.line > s.line && o.line < s.end).length;
  const ok = await confirmBox('Supprimer la section', `Supprimer « ${s.title || '(sans titre)'} » (${n} ligne${n > 1 ? 's' : ''}${sub ? `, ${sub} sous-section${sub > 1 ? 's' : ''}` : ''}${s.total ? `, ${s.total} tâche${s.total > 1 ? 's' : ''}` : ''}) ? ${MOD}+Z dans l’éditeur permet d’annuler.`, { ok: 'Supprimer', danger: true });
  if (!ok) return;
  const { lines } = parseSections(t.content);
  const before = trimEnd(lines.slice(0, s.line));
  const after = trimLead(lines.slice(s.end));
  applyLines(t, before.concat(before.length && after.length ? [''] : [], after), Math.max(0, before.length - 1));
}

async function addSection(t, { after, level, child } = {}) {
  const title = await prompt(child ? 'Nouvelle sous-section' : 'Nouvelle section', { placeholder: 'Titre', label: child ? `Sous-section de « ${after.title} »` : after ? `Après « ${after.title} »` : 'À la fin du fichier' });
  if (!title || !title.trim()) return;
  const { lines } = parseSections(t.content);
  const at = after ? after.end : lines.length;
  const lvl = level || (after ? after.level + (child ? 1 : 0) : 2);
  if (lvl > 6) { toast('Niveau maximal atteint (######).', 'err'); return; }
  const before = trimEnd(lines.slice(0, at));
  const rest = trimLead(lines.slice(at));
  const head = headingText(lvl, title.trim(), 'atx');
  const out = before.concat(before.length ? [''] : [], [head, ''], rest.length ? [''] : [], rest);
  applyLines(t, out, before.length ? before.length + 1 : 0);
}

// "- [ ] text" at the end of the section's own content (before its subsections)
function insertTaskLines(lines, s, text) {
  const headEnd = s ? s.line + (s.kind === 'setext' ? 2 : 1) : 0;
  let at = s ? s.bodyEnd : lines.length;
  while (at > headEnd && !lines[at - 1].trim()) at--;
  const out = lines.slice(0, at);
  const rest = lines.slice(at);
  const prev = out[out.length - 1];
  if (prev != null && prev.trim() && !/^\s*([-*+]|\d+[.)])\s/.test(prev)) out.push('');
  out.push('- [ ] ' + text);
  const line = out.length - 1;
  if (rest.length && rest[0].trim()) out.push('');
  return { lines: out.concat(rest), line };
}

async function addTaskToSection(t, s) {
  const text = await prompt('Nouvelle tâche', { label: s ? `Dans « ${s.title} »` : 'À la fin du fichier', placeholder: 'Description de la tâche' });
  if (!text || !text.trim()) return;
  const { lines, list } = parseSections(t.content);
  const fresh = s ? list.find((o) => o.line === s.line) : null;
  const r = insertTaskLines(lines, fresh, text.trim());
  applyLines(t, r.lines, r.line);
}

// ================================================================ view
const SEC = { collapsed: new Set(), cache: null };

function currentSectionIndex(list) {
  const t = activeTab();
  if (!t || ED.cur !== t || ED.wrap.hidden) return -1;
  const ln = ED.ta.value.slice(0, ED.ta.selectionStart).split('\n').length - 1;
  let idx = -1;
  for (const s of list) if (s.line <= ln) idx = s.index;
  return idx;
}

function renderSections() {
  const t = mdTab();
  sideHead('Sections', [
    t && editable(t) ? { icon: 'plus', title: 'Nouvelle section à la fin', action: () => addSection(t, { level: (parseSections(t.content).list[0] || { level: 1 }).level === 1 ? 2 : (parseSections(t.content).list[0] || { level: 2 }).level }) } : null,
    { icon: 'collapse', title: 'Tout réduire', action: () => { const tt = mdTab(); if (tt) parseSections(tt.content).list.forEach((s) => SEC.collapsed.add(tt.path + ':' + s.title + ':' + s.level)); drawSections(); } },
    { icon: 'up', title: 'Tout déplier', action: () => { SEC.collapsed.clear(); drawSections(); } },
  ]);
  $('.side-body').innerHTML = '<div class="sec-list"></div>';
  drawSections();
}

function drawSections() {
  if (currentView !== 'sections') return;
  const box = $('.side-body .sec-list');
  if (!box) return;
  const t = mdTab();
  box.innerHTML = '';
  if (!t) {
    box.appendChild(h('div', { class: 'empty', text: 'Ouvrez un fichier Markdown pour voir et organiser ses sections (titres # à ######).' }));
    return;
  }
  const { list } = parseSections(t.content);
  const canEdit = editable(t);
  box.appendChild(h('div', { class: 'section-head', style: { cursor: 'default' } }, h('span', { class: 'grow', style: { paddingLeft: '18px' }, text: t.name }), h('span', { class: 'count', text: list.length })));
  if (!list.length) {
    box.appendChild(h('div', { class: 'empty' }, h('div', { text: 'Aucun titre dans ce fichier.' }),
      canEdit ? h('button', { class: 'btn', style: { marginTop: '8px' }, text: 'Ajouter une section', onclick: () => addSection(t, { level: 2 }) }) : null));
    return;
  }
  const cur = currentSectionIndex(list);
  const key = (s) => t.path + ':' + s.title + ':' + s.level;
  const hiddenBy = (s) => { for (let p = s.parent; p; p = p.parent) if (SEC.collapsed.has(key(p))) return true; return false; };
  for (const s of list) {
    if (hiddenBy(s)) continue;
    const hasKids = list[s.index + 1] && list[s.index + 1].parent === s;
    const col = SEC.collapsed.has(key(s));
    const ops = sectionOps(t, s, list);
    const row = h('div', {
      class: 'row sec-row' + (s.index === cur ? ' sel' : ''), draggable: canEdit ? 'true' : null,
      style: { paddingLeft: 4 + s.depth * 14 + 'px' }, title: `${'#'.repeat(s.level)} ${s.title} — ligne ${s.line + 1}`,
      onclick: (e) => { if (e.target.closest('.acts, .tw')) return; gotoSection(t, s); },
    },
    h('span', { class: 'tw' + (hasKids && !col ? ' open' : ''), html: hasKids ? icon('right') : '', onclick: () => { col ? SEC.collapsed.delete(key(s)) : SEC.collapsed.add(key(s)); drawSections(); } }),
    h('span', { class: 'sec-lvl', text: 'H' + s.level }),
    h('span', { class: 'name', text: s.title || '(sans titre)' }),
    canEdit ? h('span', { class: 'acts' },
      h('button', { class: 'icon-btn', title: 'Ajouter une tâche dans cette section', html: icon('checkbox'), onclick: () => addTaskToSection(t, s) }),
      ops.up ? h('button', { class: 'icon-btn', title: 'Monter', html: icon('arrowUp'), onclick: ops.up }) : null,
      ops.down ? h('button', { class: 'icon-btn', title: 'Descendre', html: icon('arrowDown'), onclick: ops.down }) : null,
      h('button', { class: 'icon-btn', title: "Plus d'actions", html: icon('more'), onclick: (e) => sectionMenu(e, t, s, ops) })) : null,
    s.total ? h('span', { class: 'sec-count' + (s.done === s.total ? ' all' : ''), text: `${s.done}/${s.total}` }) : null);
    row.addEventListener('contextmenu', (e) => { e.preventDefault(); if (canEdit) sectionMenu(e, t, s, ops); });
    if (canEdit) {
      row.addEventListener('dragstart', (e) => { e.dataTransfer.setData('dash/section', String(s.line)); e.dataTransfer.effectAllowed = 'move'; });
      row.addEventListener('dragover', (e) => {
        if (!e.dataTransfer.types.includes('dash/section')) return;
        e.preventDefault();
        const r = row.getBoundingClientRect();
        row.classList.toggle('drop-before', e.clientY < r.top + r.height / 2);
        row.classList.toggle('drop-after', e.clientY >= r.top + r.height / 2);
      });
      row.addEventListener('dragleave', () => row.classList.remove('drop-before', 'drop-after'));
      row.addEventListener('drop', (e) => {
        const after = row.classList.contains('drop-after');
        row.classList.remove('drop-before', 'drop-after');
        const from = +e.dataTransfer.getData('dash/section');
        e.preventDefault();
        const fresh = parseSections(t.content).list;
        const src = fresh.find((o) => o.line === from);
        const dst = fresh.find((o) => o.line === s.line);
        if (!src || !dst || src === dst) return;
        if (dst.line > src.line && dst.line < src.end) { toast('Impossible de déplacer une section dans elle-même.', 'err'); return; }
        // before: take the target's level; after: become its next sibling (after its subsections)
        moveSection(t, src, after ? dst.end : dst.line, dst.level);
      });
    }
    box.appendChild(row);
  }
  if (canEdit) box.appendChild(h('div', { class: 'small muted', style: { padding: '10px 14px', lineHeight: 1.5 }, text: 'Glissez une section pour la déplacer (elle prend le niveau de la section cible). Clic droit pour plus d’actions.' }));
}

function sectionMenu(e, t, s, ops) {
  ctxMenu(e.clientX, e.clientY, [
    { label: 'Aller à la section', action: () => gotoSection(t, s) },
    { label: 'Ajouter une tâche…', action: () => addTaskToSection(t, s) },
    '-',
    { label: 'Renommer…', action: () => renameSection(t, s) },
    ops.up ? { label: 'Monter', action: ops.up } : null,
    ops.down ? { label: 'Descendre', action: ops.down } : null,
    ops.promote ? { label: `Remonter d’un niveau (H${s.level - 1})`, action: ops.promote } : null,
    ops.demote ? { label: `Descendre d’un niveau (H${s.level + 1})`, action: ops.demote } : null,
    '-',
    { label: 'Nouvelle section après…', action: () => addSection(t, { after: s }) },
    s.level < 6 ? { label: 'Nouvelle sous-section…', action: () => addSection(t, { after: s, child: true }) } : null,
    { label: 'Copier la section (Markdown)', action: () => navigator.clipboard.writeText(t.content.split('\n').slice(s.line, s.end).join('\n')).then(() => toast('Section copiée', 'ok', 1200)) },
    '-',
    { label: 'Supprimer la section…', danger: true, action: () => deleteSection(t, s) },
  ]);
}

function gotoSection(t, s) {
  if (t.mode === 'preview') {
    const el = ED.md.querySelector(`[data-line="${s.line}"]`);
    if (el) { el.scrollIntoView({ block: 'start' }); return; }
  }
  revealLine(t, s.line + 1);
  if (t.mode === 'split') {
    const el = ED.md.querySelector(`[data-line="${s.line}"]`);
    el && el.scrollIntoView({ block: 'start' });
  }
}

function sectionPicker() {
  const t = mdTab();
  if (!t) { toast('Ouvrez un fichier Markdown.', ''); return; }
  const { list } = parseSections(t.content);
  if (!list.length) { toast('Aucun titre dans ce fichier.', ''); return; }
  quickPick({
    placeholder: 'Aller à une section',
    items: list.map((s) => ({ label: ' '.repeat(s.depth) + (s.title || '(sans titre)'), filter: s.title, desc: 'H' + s.level + (s.total ? ` · ${s.done}/${s.total}` : ''), run: () => gotoSection(t, s) })),
  });
}

// breadcrumb: current section path
function updateBreadcrumbSection() {
  const el = $('#breadcrumb .bc-sec');
  if (!el) return;
  const t = mdTab();
  if (!t) { el.textContent = ''; return; }
  const { list } = parseSections(t.content);
  const idx = currentSectionIndex(list);
  const path = [];
  for (let s = list[idx]; s; s = s.parent) path.unshift(s.title || '…');
  el.innerHTML = path.map((p) => `<span class="sep">${icon('right')}</span><span class="seg">${esc(p)}</span>`).join('');
}
const refreshSectionsSoon = debounce(() => { drawSections(); updateBreadcrumbSection(); }, 250);
const onCursorSections = debounce(() => {
  updateBreadcrumbSection();
  if (currentView === 'sections') drawSections();
}, 120);

// ================================================================ preview folding
function decoratePreviewHeadings(t) {
  const folded = t.folded || (t.folded = new Set());
  for (const hd of ED.md.querySelectorAll(':scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > h5, :scope > h6')) {
    const btn = h('span', { class: 'fold', title: 'Replier / déplier la section', html: icon('down') });
    hd.prepend(btn);
    if (folded.has(hd.dataset.line)) foldHeading(hd);
  }
}
function foldHeading(hd) {
  const lvl = +hd.tagName[1];
  hd.classList.add('folded');
  for (let el = hd.nextElementSibling; el; el = el.nextElementSibling) {
    if (/^H[1-6]$/.test(el.tagName) && +el.tagName[1] <= lvl) break;
    el.classList.add('fold-hidden');
  }
}
function onFoldClick(t, target) {
  const hd = target.closest('h1,h2,h3,h4,h5,h6');
  if (!hd) return false;
  const folded = t.folded || (t.folded = new Set());
  const fold = !hd.classList.contains('folded');
  if (fold) folded.add(hd.dataset.line); else folded.delete(hd.dataset.line);
  // re-apply all folds in order so nested states stay consistent
  $$(':scope > *', ED.md).forEach((el) => el.classList.remove('fold-hidden'));
  for (const x of ED.md.querySelectorAll(':scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > h5, :scope > h6')) {
    x.classList.remove('folded');
    if (folded.has(x.dataset.line)) foldHeading(x);
  }
  return true;
}
