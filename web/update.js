'use strict';
/* global S, $, h, api, icon, esc, toast, toastErr, modal, confirmBox, isDirty, saveTab, DashMD, renderStatus, VERSION */

// ---------------------------------------------------------------- auto-update (GitHub Releases)
const UPD = { st: null, notified: '' };

function handleUpdate(st) {
  UPD.st = st;
  renderStatus();
  const v = st.latest && st.latest.version;
  if (!v || !st.available) return;
  const key = st.state + ':' + v;
  if (UPD.notified === key) return;
  if (st.state === 'ready') {
    UPD.notified = key;
    const t = toast(`Dash Lite ${v} est installé. Il sera utilisé au prochain lancement — ou redémarrez maintenant.`, 'ok', 0);
    t.firstChild.appendChild(h('div', { style: { marginTop: '8px', display: 'flex', gap: '6px' } },
      h('button', { class: 'btn', text: 'Redémarrer', onclick: () => { t.remove(); restartForUpdate(); } }),
      h('button', { class: 'btn secondary', text: 'Nouveautés', onclick: () => updateDialog() })));
  } else if (st.state === 'error') {
    UPD.notified = key;
    toast('Mise à jour impossible : ' + st.error, 'err', 8000);
  } else if (st.state !== 'downloading' && (st.mode === 'notify' || !st.canInstall)) {
    UPD.notified = key;
    const t = toast(`Nouvelle version disponible : Dash Lite ${v}`, '', 0);
    t.firstChild.appendChild(h('div', { style: { marginTop: '8px' } }, h('button', { class: 'btn', text: 'Voir', onclick: () => { t.remove(); updateDialog(); } })));
  }
}

function updateStatusItem(parent, item) {
  const st = UPD.st;
  if (!st || !st.latest || !st.available) return;
  const v = st.latest.version;
  if (st.state === 'downloading') item(parent, icon('pull') + ` Mise à jour ${Math.round((st.progress || 0) * 100)} %`, `Téléchargement de Dash Lite ${v}`, updateDialog);
  else if (st.state === 'ready') item(parent, icon('refresh') + ` Redémarrer (v${v})`, `Dash Lite ${v} est installé : redémarrer pour l'utiliser`, restartForUpdate);
  else item(parent, icon('arrowUp') + ` v${v} disponible`, 'Nouvelle version de Dash Lite', updateDialog);
}

async function checkForUpdates(silent) {
  let st;
  try { st = await api('update.check'); } catch (e) { if (!silent) toastErr(e); return; }
  handleUpdate(st);
  if (silent) return;
  if (!st.available) toast(`Vous utilisez la dernière version (${st.current}).`, 'ok', 3000);
  else updateDialog();
}

async function updateDialog() {
  let st = UPD.st;
  try { st = await api('update.status'); UPD.st = st; } catch { /* keep cached */ }
  if (!st) return;
  const body = h('div');
  const l = st.latest;
  body.appendChild(h('p', null, 'Version installée : ', h('b', { text: st.current }), l ? h('span', null, ' — dernière version : ', h('b', { text: l.version })) : null));
  if (!l) body.appendChild(h('p', { class: 'muted', text: st.error || 'Aucune information : cliquez sur « Vérifier ».' }));
  if (l && st.available) {
    if (st.state === 'downloading') body.appendChild(h('div', { class: 'progress', style: { margin: '8px 0' } }, h('div', { style: { width: Math.round((st.progress || 0) * 100) + '%' } })));
    if (st.state === 'ready') body.appendChild(h('p', { text: 'La nouvelle version est installée. Elle sera utilisée au prochain lancement, ou tout de suite si vous redémarrez.' }));
    if (st.state === 'error') body.appendChild(h('p', { style: { color: 'var(--red)' }, text: st.error }));
    if (!st.canInstall && st.reason) body.appendChild(h('p', { class: 'muted small', text: 'Installation automatique impossible : ' + st.reason + '. Téléchargez-la depuis la page de la version.' }));
    if (l.notes) {
      const notes = h('div', { class: 'md', style: { maxHeight: '40vh', overflow: 'auto', border: '1px solid #3c3c3c', padding: '8px 12px', fontSize: '13px' } });
      notes.innerHTML = DashMD.createRenderer({ resolveImg: (s) => s })(l.notes);
      notes.addEventListener('click', (e) => { const a = e.target.closest('a[data-href]'); if (a) { e.preventDefault(); if (/^https?:/.test(a.dataset.href)) api('os.openUrl', { url: a.dataset.href }); } });
      body.append(h('div', { class: 'small muted', style: { margin: '8px 0 4px' }, text: 'Nouveautés' }), notes);
    }
  } else if (l) body.appendChild(h('p', { class: 'muted', text: 'Vous utilisez la dernière version.' }));
  const mode = { auto: 'automatique', notify: 'notification seulement', off: 'désactivée' }[st.mode] || st.mode;
  body.appendChild(h('p', { class: 'small muted', style: { marginTop: '10px' }, text: `Mise à jour ${mode} (Paramètres) · source : github.com/${st.repo}/releases` + (st.checkedAt ? ' · vérifié ' + new Date(st.checkedAt).toLocaleTimeString() : '') }));
  const buttons = [{ label: 'Fermer', kind: 'secondary', value: null }, { label: 'Vérifier', kind: 'secondary', value: 'check' }];
  if (l && l.url) buttons.splice(1, 0, { label: 'Page de la version', kind: 'secondary', value: 'page' });
  if (l && st.available && st.canInstall && st.state !== 'ready' && st.state !== 'downloading') buttons.push({ label: 'Installer ' + l.version, primary: true, value: 'install' });
  if (st.state === 'ready') buttons.push({ label: 'Redémarrer maintenant', primary: true, value: 'restart' });
  const v = await modal({ title: 'Mises à jour', wide: true, body, buttons });
  if (v === 'check') checkForUpdates(false);
  else if (v === 'page') api('os.openUrl', { url: l.url }).catch(toastErr);
  else if (v === 'install') { api('update.install').catch(toastErr); toast('Téléchargement de la mise à jour…', '', 2500); }
  else if (v === 'restart') restartForUpdate();
}

async function restartForUpdate() {
  const dirty = [...S.ws.values()].flatMap((w) => w.tabs.filter(isDirty));
  const running = [...S.sessions.values()].filter((s) => s.info.running).length;
  if (dirty.length || running) {
    const parts = [];
    if (dirty.length) parts.push(`${dirty.length} fichier(s) non enregistré(s) seront enregistrés`);
    if (running) parts.push(`${running} processus en cours seront arrêtés`);
    if (!(await confirmBox('Redémarrer Dash Lite', parts.join(' et ') + '. Continuer ?', { ok: 'Redémarrer' }))) return;
    for (const t of dirty) if (!(await saveTab(t))) return;
  }
  const target = UPD.st && UPD.st.ready;
  try { await api('update.restart'); } catch (e) { toastErr(e); return; }
  document.body.appendChild(h('div', { class: 'modal-back', style: { alignItems: 'center', paddingTop: 0 } },
    h('div', { class: 'modal', style: { padding: '24px', textAlign: 'center' } }, h('div', { text: 'Redémarrage de Dash Lite' + (target ? ' ' + target : '') + '…' }))));
  window.onbeforeunload = null;
  const started = Date.now();
  await new Promise((r) => setTimeout(r, 800));
  for (;;) {
    try {
      const r = await fetch('/api/ping', { cache: 'no-store' });
      const j = await r.json();
      if (j.version !== VERSION || Date.now() - started > 6000) { location.reload(); return; }
    } catch { /* server restarting */ }
    if (Date.now() - started > 30000) { location.reload(); return; }
    await new Promise((r) => setTimeout(r, 400));
  }
}
