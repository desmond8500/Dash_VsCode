'use strict';
/* global S, $, h, api, icon, toast, toastErr, modal, confirmBox, ctxMenu, copyText, quickPick, sideHead, section, renderSidebar, currentView, upsertSession, showSession, showPanel, sessionsOf */

// ================================================================ SSH view
// Saved connections live in the configuration (shared by all projects); a connection opens
// in a session of the terminal panel of the current project. Passwords are never saved:
// ssh asks for them through a dialog (see ssh.go, askpass).
const SSH = { data: null, form: null, collapsed: new Set() };

async function refreshSsh() {
  try { SSH.data = await api('ssh.list'); } catch (e) { SSH.data = { conns: [], hosts: [], ssh: true, error: e.message }; }
  if (currentView === 'ssh') drawSsh();
}

function renderSsh(focus) {
  sideHead('SSH', [
    { icon: 'plus', title: 'Nouvelle connexion', action: () => { SSH.form = {}; drawSsh(); } },
    { icon: 'refresh', title: 'Actualiser', action: refreshSsh },
  ]);
  const body = $('.side-body');
  body.innerHTML = '';
  body.appendChild(h('div', { class: 'cmd-list ssh-list' }));
  drawSsh();
  refreshSsh();
  void focus;
}

function sshSession(id) {
  return sessionsOf(S.pid).find((s) => s.info.ssh === id);
}

function sshTarget(c) {
  return (c.user ? c.user + '@' : '') + c.host + (c.port && c.port !== 22 ? ':' + c.port : '');
}

function drawSsh() {
  const box = $('.side-body .ssh-list');
  if (!box) return;
  box.innerHTML = '';
  const d = SSH.data;
  if (d && !d.ssh) {
    box.appendChild(h('div', { class: 'ssh-warn' },
      h('div', { text: 'La commande ssh est introuvable.' }),
      h('div', { class: 'hint', text: 'Installez le client OpenSSH (Windows : Paramètres → Applications → Fonctionnalités facultatives → Client OpenSSH ; Linux : paquet openssh-client).' })));
  }
  if (SSH.form) box.appendChild(sshForm(SSH.form));
  if (!d) { box.appendChild(h('div', { class: 'empty', text: 'Chargement…' })); return; }

  const s1 = section('saved', 'Connexions', d.conns.length, [{ icon: 'plus', title: 'Nouvelle connexion', action: () => { SSH.form = {}; drawSsh(); } }], SSH.collapsed);
  box.appendChild(s1.head);
  if (!s1.col) {
    if (!d.conns.length && !SSH.form) {
      box.appendChild(h('div', { class: 'empty small', style: { padding: '4px 20px 8px' } },
        h('div', { text: 'Enregistrez vos serveurs (hôte, utilisateur, port, clé…) pour vous y connecter en un clic.' }),
        h('button', { class: 'btn block', style: { marginTop: '8px' }, text: 'Nouvelle connexion', onclick: () => { SSH.form = {}; drawSsh(); } })));
    }
    d.conns.forEach((c, i) => box.appendChild(sshRow(c, sshTarget(c) + (c.dir ? '  ' + c.dir : ''), [
      { icon: 'edit', title: 'Modifier', action: () => { SSH.form = { ...c }; drawSsh(); } },
      { icon: 'more', title: 'Plus d’actions', action: (e) => sshMenu(e, c, i, d.conns.length) },
    ], () => sshConnect({ id: c.id }))));
  }

  const saved = new Set(d.conns.map((c) => c.host));
  const hosts = (d.hosts || []).filter((x) => !saved.has(x.alias));
  if (hosts.length) {
    const s2 = section('config', 'Depuis ~/.ssh/config', hosts.length, [], SSH.collapsed);
    box.appendChild(s2.head);
    if (!s2.col) {
      for (const x of hosts) {
        const c = { id: 'cfg:' + x.alias, name: x.alias };
        const sub = (x.user ? x.user + '@' : '') + (x.hostname || x.alias) + (x.port && x.port !== '22' ? ':' + x.port : '');
        box.appendChild(sshRow(c, sub, [
          { icon: 'star', title: 'Enregistrer cette connexion', action: () => saveSsh({ name: x.alias, host: x.alias }) },
        ], () => sshConnect({ alias: x.alias })));
      }
    }
  }
  box.appendChild(h('div', { class: 'empty small', style: { padding: '12px 20px', textAlign: 'left' }, text: 'Les mots de passe ne sont jamais enregistrés : ils sont demandés à la connexion. Avec une clé SSH, la connexion est directe.' }));
}

function sshRow(c, sub, acts, connect) {
  const s = sshSession(c.id);
  const run = s && s.info.running;
  return h('div', { class: 'row cmd-row', style: { paddingLeft: '20px' }, title: 'Se connecter à ' + c.name, onclick: (e) => { if (!e.target.closest('.acts')) connect(); } },
    h('span', { class: 'icon-btn', style: { color: run ? 'var(--blue)' : 'var(--green)' }, html: icon('server') }),
    h('span', { class: 'txt' }, h('span', { text: c.name }), h('span', { class: 'cmd-line', text: sub })),
    run ? h('span', { class: 'dot run', title: 'Connecté' }) : null,
    h('span', { class: 'acts' }, ...acts.map((a) => h('button', { class: 'icon-btn', title: a.title, html: icon(a.icon), onclick: (e) => { e.stopPropagation(); a.action(e); } }))));
}

function sshMenu(e, c, i, n) {
  const r = e.currentTarget.getBoundingClientRect();
  ctxMenu(r.left, r.bottom + 2, [
    { label: 'Se connecter', action: () => sshConnect({ id: c.id }) },
    { label: 'Modifier', action: () => { SSH.form = { ...c }; drawSsh(); } },
    { label: 'Dupliquer', action: () => { SSH.form = { ...c, id: undefined, name: c.name + ' (copie)' }; drawSsh(); } },
    { label: 'Copier la commande ssh', action: async () => { try { copyText(await api('ssh.command', { conn: c })); } catch (err) { toastErr(err); } } },
    '-',
    i > 0 ? { label: 'Monter', action: () => api('ssh.move', { id: c.id, delta: -1 }).then(refreshSsh) } : null,
    i < n - 1 ? { label: 'Descendre', action: () => api('ssh.move', { id: c.id, delta: 1 }).then(refreshSsh) } : null,
    '-',
    { label: 'Supprimer', danger: true, action: async () => { if (await confirmBox('Supprimer la connexion', `Supprimer « ${c.name} » ?`, { ok: 'Supprimer', danger: true })) api('ssh.delete', { id: c.id }).then(refreshSsh).catch(toastErr); } },
  ]);
}

function sshForm(f) {
  const field = (label, input, hint) => h('div', { class: 'field' }, h('label', { text: label }), input, hint ? h('div', { class: 'hint', text: hint }) : null);
  const inp = (key, placeholder, extra = {}) => h('input', { class: 'input', value: f[key] == null ? '' : String(f[key]), placeholder, spellcheck: 'false', autocomplete: 'off', ...extra });
  const name = inp('name', 'Mon serveur');
  const host = inp('host', 'exemple.com ou 192.168.1.10');
  const user = inp('user', 'root');
  const port = inp('port', '22', { type: 'number', min: '1', max: '65535', style: { width: '80px' } });
  const key = inp('key', '~/.ssh/id_ed25519 (facultatif)');
  const dir = inp('dir', '/var/www/monsite (facultatif)');
  const jump = inp('jump', 'utilisateur@bastion (facultatif)');
  const options = inp('options', '-o StrictHostKeyChecking=accept-new (facultatif)', { style: { fontFamily: 'var(--mono)', fontSize: '12px' } });
  // "user@host:port" pasted in the host field is split automatically
  host.addEventListener('change', () => {
    const m = host.value.trim().match(/^(?:ssh\s+)?(?:([^@\s]+)@)?([^:\s]+)(?::(\d+))?$/);
    if (m && (m[1] || m[3])) { host.value = m[2]; if (m[1]) user.value = m[1]; if (m[3]) port.value = m[3]; }
  });
  const more = h('details', { class: 'ssh-more' }, h('summary', { text: 'Options avancées' }),
    field('Rebond (ProxyJump)', jump), field('Options ssh supplémentaires', options));
  if (f.jump || f.options) more.open = true;
  const close = () => { SSH.form = null; drawSsh(); };
  const save = async (connect) => {
    if (!host.value.trim()) { host.focus(); return; }
    const c = await saveSsh({ id: f.id, name: name.value, host: host.value, user: user.value, port: parseInt(port.value, 10) || 0, key: key.value, dir: dir.value, jump: jump.value, options: options.value });
    if (c && connect) sshConnect({ id: c.id });
  };
  const box = h('div', { class: 'cmd-form ssh-form' },
    field('Nom', name),
    h('div', { class: 'ssh-grid' }, field('Hôte', host), field('Port', port)),
    field('Utilisateur', user),
    field('Clé privée', key, 'Vide = clés par défaut et agent SSH ; sinon le mot de passe est demandé à la connexion.'),
    field('Dossier distant', dir, 'Dossier ouvert à la connexion.'),
    more,
    h('div', { class: 'btn-row' },
      h('button', { class: 'btn secondary', text: 'Annuler', onclick: close }),
      h('button', { class: 'btn secondary', text: 'Enregistrer', onclick: () => save(false) }),
      h('button', { class: 'btn', text: 'Enregistrer et connecter', onclick: () => save(true) })));
  box.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); save(false); } if (e.key === 'Escape') close(); });
  setTimeout(() => (f.host ? name : host).focus());
  return box;
}

async function saveSsh(c) {
  try {
    const saved = await api('ssh.save', { conn: c });
    SSH.form = null;
    toast('Connexion enregistrée', 'ok', 1500);
    await refreshSsh();
    return saved;
  } catch (e) { toastErr(e); return null; }
}

async function sshConnect(req) {
  if (!S.pid) { toast('Ouvrez d’abord un projet : la connexion s’ouvre dans son terminal.', 'err'); return; }
  try {
    const info = await api('ssh.connect', { p: S.pid, ...req });
    const s = upsertSession(info);
    if (!info.running && s.info.running) s.info.running = true;
    showPanel(true);
    showSession(info.id);
    $('#term-input').focus();
    if (currentView === 'ssh') drawSsh();
  } catch (e) { toastErr(e); }
}

// quick picker (Ctrl+Maj+H, command palette)
async function sshPicker() {
  await refreshSsh();
  const d = SSH.data || { conns: [], hosts: [] };
  const items = [
    ...d.conns.map((c) => ({ label: c.name, desc: sshTarget(c), icon: icon('server'), filter: c.name + ' ' + sshTarget(c), run: () => sshConnect({ id: c.id }) })),
    ...(d.hosts || []).filter((x) => !d.conns.some((c) => c.host === x.alias)).map((x) => ({ label: x.alias, desc: '~/.ssh/config', icon: icon('server'), filter: x.alias, run: () => sshConnect({ alias: x.alias }) })),
    { label: '+ Nouvelle connexion…', filter: 'nouvelle connexion ajouter', run: newSsh },
  ];
  quickPick({ placeholder: 'Se connecter en SSH', items });
}

// ---------------------------------------------------------------- password / confirmation dialog
const askOpen = new Map(); // ask id → close()

function onAskpass(m) {
  if (askOpen.has(m.ask)) return;
  const prompt = String(m.prompt || '').trim();
  const yesNo = /\(yes\/no/i.test(prompt);
  const lines = prompt.split('\n');
  const question = lines.pop();
  const info = lines.join('\n').trim();
  const input = h('input', { class: 'input', type: 'password', autocomplete: 'off', spellcheck: 'false' });
  const show = h('label', { class: 'check' }, h('input', { type: 'checkbox', onchange: (e) => { input.type = e.target.checked ? 'text' : 'password'; input.focus(); } }), ' Afficher');
  const body = h('div', null,
    info ? h('pre', { class: 'output', text: info }) : null,
    h('p', { text: question }),
    yesNo ? h('p', { class: 'hint', text: 'Premier contact avec ce serveur : vérifiez l’empreinte si vous le pouvez, puis faites-lui confiance pour l’enregistrer dans known_hosts.' }) : h('div', { class: 'field' }, input, show),
    yesNo ? null : h('div', { class: 'hint', text: 'Envoyé à ssh uniquement, jamais enregistré.' }));
  const buttons = yesNo
    ? [{ label: 'Refuser', kind: 'secondary', value: { cancel: true } }, { label: 'Faire confiance et continuer', primary: true, value: { answer: 'yes' } }]
    : [{ label: 'Annuler', kind: 'secondary', value: { cancel: true } }, { label: 'Envoyer', primary: true, value: () => ({ answer: input.value }) }];
  modal({
    title: m.name || 'SSH',
    body,
    buttons,
    dismiss: false,
    onOpen: (_el, close) => askOpen.set(m.ask, close),
  }).then((v) => {
    const wasOpen = askOpen.delete(m.ask);
    if (v === undefined || !wasOpen) return; // closed because answered elsewhere
    const r = v || { cancel: true };
    api('ssh.answer', { ask: m.ask, answer: r.answer || '', cancel: !!r.cancel }).catch(() => {});
  });
}

function onAskpassDone(m) {
  const close = askOpen.get(m.ask);
  if (!close) return;
  askOpen.delete(m.ask);
  close(undefined);
}

function newSsh() { window.showView('ssh'); SSH.form = {}; drawSsh(); }

window.SSHView = { refreshSsh, renderSsh, drawSsh, sshPicker, newSsh, onAskpass, onAskpassDone };
