const app = document.querySelector('#app'), notice = document.querySelector('#notice');
const roles = ['owner', 'admin', 'member', 'viewer'], classes = ['general', 'developer', 'analyst', 'marketing'];
let me, companyId, page = 'overview', activeConversation, fieldId = 0, noticeTimer;
const hash = new URLSearchParams(location.hash.slice(1));
const inviteToken = hash.get('invite'), setupToken = hash.get('setup');
// "Sign in with browser" in the Mac or iPhone app opens /#device=CODE: allowed here by whoever is signed in.
// /#device alone (typed in on another computer) asks for the code the app shows.
let deviceCode = hash.has('device') ? (/^[A-Z2-9]{4}-?[A-Z2-9]{4}$/i.test(hash.get('device')) ? hash.get('device').toUpperCase() : '') : null;
if (inviteToken || setupToken || deviceCode !== null) history.replaceState(null, '', '/');

// ---- small DOM helpers
function el(tag, value, attributes = {}, ...children) {
  const node = document.createElement(tag);
  if (value !== undefined && value !== null) node.textContent = value;
  for (const [key, v] of Object.entries(attributes)) node.setAttribute(key, v);
  node.append(...children.filter(Boolean));
  return node;
}
const ICONS = {
  notes: 'M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2M9 5a2 2 0 0 0 2 2h2a2 2 0 0 0 2-2 2 2 0 0 0-2-2h-2a2 2 0 0 0-2 2zM9 12l2 2 4-4',
  trash: 'M4 7h16M10 11v6M14 11v6M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-12M9 7V4h6v3',
  grip: 'M9 6h.01M9 12h.01M9 18h.01M15 6h.01M15 12h.01M15 18h.01',
  overview: 'M3 10.5 12 4l9 6.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z',
  conversations: 'M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z',
  team: 'M16 19v-1a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v1M9.5 10a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM21 19v-1a4 4 0 0 0-3-3.9M16 3.1a3.5 3.5 0 0 1 0 6.8',
  tools: 'M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18v3h3l6.3-6.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.4-.6-.6-2.4z',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-2.9-1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 3 14H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.2-2.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 10 3.1V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 2.9 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0 1.2 2.9H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  account: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0',
  out: 'M15 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4M10 17l5-5-5-5M15 12H3',
  plus: 'M12 5v14M5 12h14',
};
function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('class', 'i');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path'); path.setAttribute('d', ICONS[name]);
  svg.append(path); return svg;
}
function brand() { return el('div', null, { class: 'brand' }, el('span', '›_', { class: 'mark' }), el('span', 'TerminAI')); }
function initials(name = '') { return name.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('') || '?'; }
function message(value, error = false) {
  notice.textContent = value; notice.className = error ? 'error' : '';
  clearTimeout(noticeTimer); if (value) noticeTimer = setTimeout(() => { notice.textContent = ''; }, error ? 7000 : 3500);
}
async function api(path, method = 'GET', data) {
  const response = await fetch(path, { method, credentials: 'same-origin', headers: data ? { 'Content-Type': 'application/json' } : {}, body: data ? JSON.stringify(data) : undefined });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Request failed.');
  return result;
}
function run(fn) {
  return async event => {
    event?.preventDefault();
    const button = event?.submitter || (event?.currentTarget instanceof HTMLButtonElement ? event.currentTarget : null);
    if (button) button.disabled = true;
    try { await fn(event); } catch (error) { message(error.message, true); } finally { if (button) button.disabled = false; }
  };
}
function download() {
  return el('a', null, { class: 'download', href: 'https://github.com/ClipWave-io/terminai/releases/latest', target: '_blank', rel: 'noopener' },
    el('b', 'Download for Mac'), el('span', 'Apple Silicon · signed · updates itself'));
}
function button(label, fn, kind = '') {
  const b = el('button', label, { type: 'button' }); if (kind) b.className = kind;
  b.addEventListener('click', run(fn)); return b;
}
function field(parent, label, name, type = 'text', value = '', options) {
  const input = el(options ? 'select' : type === 'textarea' ? 'textarea' : 'input');
  input.name = name; input.id = `field-${++fieldId}`;
  if (options) for (const option of options) input.append(el('option', option[0].toUpperCase() + option.slice(1), { value: option }));
  else if (type !== 'textarea') input.type = type;
  input.value = value; input.required = true;
  if (type === 'password') input.minLength = 12;
  if (type === 'email') input.autocomplete = 'email';
  const wrap = el('label', label); wrap.htmlFor = input.id; wrap.append(input); parent.append(wrap);
  return input;
}
function chips(name, values, checked) {
  const box = el('div', null, { class: 'chips' });
  for (const value of values) {
    const box2 = el('input', null, { type: 'checkbox', name, value }); box2.checked = checked(value);
    box.append(el('label', null, {}, box2, document.createTextNode(value)));
  }
  return box;
}
function form(onSubmit) {
  const f = el('form');
  f.addEventListener('submit', run(async event => onSubmit(Object.fromEntries(new FormData(f)), f, event)));
  return f;
}
function submit(f, label, kind = '') { const b = el('button', label, { type: 'submit' }); if (kind) b.className = kind; f.append(b); return b; }
function card(title, description, ...children) {
  return el('section', null, { class: 'card' },
    title && el('div', null, { class: 'card-head' }, el('div', null, {}, el('h2', title), description && el('p', description, { class: 'small' }))),
    ...children);
}
function base() { return `/api/companies/${companyId}`; }
async function refresh() { me = await api('/api/me'); if (deviceCode !== null) return showDevice(); await workspace(); }

// ---- sign in, first setup, invitation
function authPage(title, subtitle, f) {
  const art = el('aside', null, { class: 'auth-art' },
    brand(),
    el('div', null, {},
      el('h2', 'Your AI terminals, synced everywhere.'),
      el('p', 'Notes, conversations and tools for your Claude Code and Codex sessions, the same on your Mac, iPhone and the web. Use it alone, or invite people whenever you like.', { class: 'dim' }),
      download(),
      el('div', null, { class: 'term' },
        el('div', null, { class: 'term-bar' }, el('i'), el('i'), el('i')),
        el('div', null, { class: 'term-body' },
          line('$ ', 'terminai sync', ''), line('', '✓ ', 'Signed in'),
          line('', '✓ ', 'Notes synced to your iPhone'), line('', '✓ ', '3 conversations')))),
    el('small', 'Agents run on each person’s Mac. This server only stores accounts, access and shared history.'));
  function line(prompt, strong, rest) {
    const d = el('div'); if (prompt) d.append(prompt);
    d.append(prompt ? el('b', strong) : el('em', strong)); if (rest) d.append(rest); return d;
  }
  const main = el('main', null, { class: 'auth-main' }, el('div', null, { class: 'auth-card' },
    el('header', null, {}, el('h1', title), el('p', subtitle, { class: 'dim' })), f), el('div', null, { class: 'auth-download' }, download()));
  app.replaceChildren(el('div', null, { class: 'auth' }, art, main));
  f.querySelector('input')?.focus();
}
let authMode = 'signin';
function showDevice() {
  const code = deviceCode;
  const f = form(async data => {
    await api('/api/auth/device/approve', 'POST', { code: code || data.code });
    deviceCode = null;
    const done = el('div', null, { class: 'device-done' }, el('p', 'The app is signed in. You can go back to TerminAI.'));
    done.append(button('Open my workspace', () => workspace(), 'secondary'));
    authPage('TerminAI is signed in', `As ${me.user.email}.`, done);
  });
  if (code) f.append(el('div', code, { class: 'device-code', 'aria-label': 'Code' }));
  else { const input = field(f, 'Code shown in the app', 'code'); input.autocomplete = 'off'; input.placeholder = 'ABCD-EFGH'; input.classList.add('device-input'); }
  f.append(el('small', 'Allow only if TerminAI on your iPhone or Mac shows this same code, and you started the sign-in there yourself.'));
  submit(f, 'Allow', 'block');
  f.append(button('Cancel', () => { deviceCode = null; workspace(); }, 'secondary block'));
  authPage('Sign in TerminAI?', `As ${me.user.name} (${me.user.email}).`, f);
}
async function start() {
  const setup = await api('/api/setup');
  try { me = await api('/api/me'); } catch { me = null; }
  if (inviteToken) return showInvitation();
  if (me && deviceCode !== null) return showDevice();
  if (me) return workspace();
  // Only when a server operator turned public sign-up off: the first owner proves they run the server.
  if (setup.setupRequired && !setup.signupOpen) {
    const f = form(async data => { await api('/api/setup', 'POST', data); await refresh(); });
    field(f, 'Setup token', 'setupToken', 'password', setupToken || '');
    const two = el('div', null, { class: 'fields' }); field(two, 'Your name', 'name'); field(two, 'Workspace name', 'companyName'); f.append(two);
    field(f, 'Email', 'email', 'email'); field(f, 'Password', 'password', 'password');
    submit(f, 'Create account', 'block');
    f.append(el('small', 'Sign-up is closed on this server. The token is the SETUP_TOKEN variable of the server’s hosting (for example Railway → Variables).'));
    return authPage('Set up this server', 'Create the first owner account.', f);
  }
  const toggle = (text, link, mode) => {
    const p = el('small', text + ' '), a = el('a', link, { href: '#' });
    a.addEventListener('click', e => { e.preventDefault(); authMode = mode; start(); }); p.append(a); return p;
  };
  if (authMode === 'signup' && setup.signupOpen) {
    const f = form(async data => { await api('/api/auth/signup', 'POST', data); await refresh(); });
    field(f, 'Your name', 'name');
    field(f, 'Email', 'email', 'email');
    const pw = field(f, 'Password', 'password', 'password'); pw.placeholder = '12 characters or more'; pw.autocomplete = 'new-password';
    submit(f, 'Create account', 'block');
    f.append(toggle('Already have an account?', 'Sign in', 'signin'),
      el('small', 'Joining someone’s workspace? Open the invitation link they sent you instead.'));
    return authPage('Create your account', 'Free. Use it by yourself; invite people only if you want to.', f);
  }
  const f = form(async data => { await api('/api/auth/login', 'POST', data); await refresh(); });
  field(f, 'Email', 'email', 'email');
  const password = field(f, 'Password', 'password', 'password'); password.removeAttribute('minlength'); password.autocomplete = 'current-password';
  submit(f, 'Sign in', 'block');
  if (setup.signupOpen) f.append(toggle('New to TerminAI?', 'Create an account', 'signup'));
  f.append(el('small', 'Invited by someone? Open the link they sent you.'));
  if (deviceCode) {
    // The phone opened this page but has no session here: the person is usually signed in on their Mac instead.
    f.prepend(el('div', null, { class: 'device-hint' }, el('strong', `No password? Your code is ${deviceCode}.`),
      el('small', 'On your Mac, open this website where you are signed in, go to Account › Enter a code, and type it there. This phone then signs in by itself.')));
  }
  authPage('Welcome back', 'Sign in to sync your notes and sessions.', f);
}
function showInvitation() {
  const f = form(async data => { await api('/api/auth/accept-invite', 'POST', { ...data, token: inviteToken }); location.replace('/'); });
  field(f, 'Your name', 'name'); field(f, 'Password', 'password', 'password');
  submit(f, 'Join', 'block');
  f.append(el('small', 'Already have an account? Enter its password. Otherwise choose a new one, 12 characters or more.'));
  authPage('You’re invited', 'Join a shared workspace on TerminAI.', f);
}

// ---- workspace shell
const PAGES = [
  ['overview', 'Overview', 'overview'], ['notes', 'Notes', 'notes'], ['conversations', 'Conversations', 'conversations'],
  ['team', 'People', 'team', c => ['owner', 'admin'].includes(c.role)], ['tools', 'Tools', 'tools'],
  ['settings', 'Workspace settings', 'settings', c => c.role === 'owner'], ['account', 'Account', 'account'],
];
async function workspace() {
  if (!me.companies.length) {
    const f = form(async data => { await api('/api/companies', 'POST', data); await refresh(); });
    field(f, 'Workspace name', 'name', 'text', `${me.user.name.split(' ')[0]}’s workspace`); submit(f, 'Create workspace', 'block');
    f.append(el('small', 'Or open an invitation link someone sent you.'),
      button('Sign out', async () => { await api('/api/auth/logout', 'POST', {}); location.reload(); }, 'secondary'));
    return authPage(`Hi ${me.user.name.split(' ')[0]}`, 'You don’t have a workspace yet. Create one:', f);
  }
  if (!me.companies.some(c => c.id === companyId)) companyId = me.companies[0].id;
  const company = me.companies.find(c => c.id === companyId);
  const pages = PAGES.filter(p => !p[3] || p[3](company));
  if (!pages.some(p => p[0] === page)) page = 'overview';

  const nav = el('nav');
  for (const [key, label, ic] of pages) {
    const b = el('button', null, { type: 'button' }, icon(ic), document.createTextNode(label));
    if (key === page) b.setAttribute('aria-current', 'page');
    b.addEventListener('click', run(async () => { page = key; await workspace(); }));
    nav.append(b);
  }
  let switcher = null;
  if (me.companies.length > 1) {
    switcher = el('select', null, { 'aria-label': 'Workspace' });
    for (const c of me.companies) switcher.append(el('option', c.name, { value: c.id }));
    switcher.value = companyId;
    switcher.addEventListener('change', run(async () => { companyId = switcher.value; activeConversation = null; await workspace(); }));
  }
  const side = el('aside', null, { class: 'side' },
    brand(),
    switcher || el('div', null, { class: 'small' }, el('strong', company.name), document.createTextNode(` · ${company.role}`)),
    nav,
    el('div', null, { class: 'me' }, el('span', initials(me.user.name), { class: 'avatar' }),
      el('div', null, {}, el('strong', me.user.name), el('small', me.user.email)),
      (() => { const b = button('', async () => { await api('/api/auth/logout', 'POST', {}); location.reload(); }, 'secondary'); b.append(icon('out')); b.title = 'Sign out'; return b; })()));
  const main = el('main', null, { class: 'main' });
  app.replaceChildren(el('div', null, { class: 'shell' }, side, main));
  await ({ overview, notes, conversations, team, tools, settings, account })[page](main, company);
}
function head(main, title, subtitle, action) {
  main.append(el('div', null, { class: 'page-head' }, el('div', null, {}, el('h1', title), subtitle && el('p', subtitle)), action));
}

// ---- pages
async function overview(main, company) {
  head(main, `Hi, ${me.user.name.split(' ')[0]}`, `${company.name} · you’re ${company.role === 'owner' ? 'the owner' : `a${company.role === 'admin' ? 'n' : ''} ${company.role}`}, ${company.classification}`);
  const { conversations: list } = await api(`${base()}/conversations`);
  const { catalog } = await api(`${base()}/catalog`);
  const stats = el('div', null, { class: 'stats' },
    stat(list.length, 'conversations'), stat(list.filter(c => c.visibility === 'company').length, 'shared'),
    stat(catalog.filter(t => t.assigned).length, `of ${catalog.length} tools assigned to you`));
  if (['owner', 'admin'].includes(company.role)) {
    const { members } = await api(`${base()}/members`); stats.prepend(stat(members.length, members.length === 1 ? 'member' : 'members'));
  }
  main.append(el('div', null, { class: 'stack' }, stats,
    download(),
    el('h2', 'Getting started'),
    el('div', null, { class: 'steps' },
      step('Write things down', 'Notes has your private list, which only you ever see, and a shared board with a column for each person.'),
      step('Sync your Mac and iPhone', 'Download TerminAI for Mac (above) or open the TerminAI iPhone app, and sign in with this account.'),
      step('Invite people, if you want', 'Under People, create an invitation link. It works once and expires after 48 hours.'),
      step('Pick tools per role', 'Developers get the browser tools, analysts and marketing get Google Ads. Change it under Tools.'),
      step('Share on purpose', 'Conversations are private unless you share them. Nobody’s messages ever run as commands.'))));
  function stat(n, label) { return el('div', null, { class: 'stat' }, el('b', String(n)), el('small', label)); }
  function step(title, text) { return el('div', null, { class: 'card' }, el('h3', title), el('p', text, { class: 'small' })); }
}

// ---- notes: a private list per person and the team's board, a column for each member
let notesView = 'private', showDone = false;
const NOTE_MIME = 'application/x-terminai-note';
async function notes(main, company) {
  const [{ notes: everything }, { members }] = await Promise.all([api(`${base()}/notes`), api(`${base()}/members`)]);
  const all = everything.filter(n => n.kind !== 'doc');
  const canTeam = company.role !== 'viewer';
  const save = (n, patch) => api(`${base()}/notes/${n.id}`, 'PATCH', patch);
  // Alone in a workspace there is nobody to share a board with: just the private list.
  if (members.length < 2) notesView = 'private';
  const tabs = el('div', null, { class: 'seg' });
  for (const [key, label] of [['private', 'My notes'], ['company', 'Shared board']]) {
    const b = el('button', label, { type: 'button', 'aria-pressed': String(notesView === key) });
    b.addEventListener('click', run(async () => { notesView = key; await workspace(); })); tabs.append(b);
  }
  const doneCount = all.filter(n => n.visibility === notesView && n.status === 'done').length;
  const doneToggle = button(showDone ? 'Hide done' : `Show done${doneCount ? ` (${doneCount})` : ''}`, async () => { showDone = !showDone; await workspace(); }, 'secondary');
  head(main, 'Notes', notesView === 'private' ? 'Only you can see these, even in a shared workspace.' : `Shared with everyone in ${company.name}.`, el('div', null, { class: 'actions' }, members.length > 1 ? tabs : null, doneToggle));
  const visible = all.filter(n => n.visibility === notesView && (showDone || n.status === 'open'));

  function adder(extra = {}, placeholder = 'Add a note…') {
    const f = form(async (data, f) => {
      await api(`${base()}/notes`, 'POST', { title: data.title, visibility: notesView, ...extra });
      await workspace(); document.querySelector(`[data-adder="${extra.assigneeId || 'none'}"] input`)?.focus();
    });
    f.className = 'adder'; f.dataset.adder = extra.assigneeId || 'none';
    const input = el('input', null, { name: 'title', placeholder, 'aria-label': placeholder, maxlength: '500', autocomplete: 'off' }); input.required = true;
    f.append(input); return f;
  }
  function noteCard(n) {
    const box = el('input', null, { type: 'checkbox', 'aria-label': 'Done' }); box.checked = n.status === 'done';
    box.addEventListener('change', run(async () => { await save(n, { status: box.checked ? 'done' : 'open' }); await workspace(); }));
    const title = el('input', null, { class: 'note-title', 'aria-label': 'Title', maxlength: '500' }); title.value = n.title;
    title.addEventListener('change', run(async () => { if (title.value.trim()) await save(n, { title: title.value }); }));
    title.addEventListener('keydown', e => { if (e.key === 'Enter') title.blur(); });
    const body = el('textarea', null, { class: 'note-body', placeholder: 'Details…', 'aria-label': 'Details', rows: '1' }); body.value = n.body;
    const grow = () => { body.style.height = 'auto'; body.style.height = body.scrollHeight + 'px'; };
    body.addEventListener('input', grow); requestAnimationFrame(grow);
    body.addEventListener('change', run(async () => { await save(n, { body: body.value }); }));
    const tools = el('div', null, { class: 'note-tools' });
    if (n.visibility === 'private' && canTeam) tools.append(button('Move to shared board', async () => { await save(n, { visibility: 'company' }); message('Moved to the shared board.'); await workspace(); }, 'ghost'));
    if (n.visibility === 'company' && n.ownerId === me.user.id) tools.append(button('Make private', async () => { await save(n, { visibility: 'private' }); await workspace(); }, 'ghost'));
    if (n.ownerId === me.user.id || ['owner', 'admin'].includes(company.role)) {
      const del = button('', async () => { if (confirm(`Delete “${n.title}”?`)) { await api(`${base()}/notes/${n.id}`, 'DELETE'); await workspace(); } }, 'ghost'); del.append(icon('trash')); del.title = 'Delete'; tools.append(del);
    }
    const by = n.visibility === 'company' && n.updatedByName ? el('small', `${n.updatedBy === me.user.id ? 'You' : n.updatedByName} · ${new Date(n.updatedAt).toLocaleDateString()}`) : null;
    const grip = el('span', null, { class: 'grip', draggable: 'true', title: 'Drag to move' }); grip.append(icon('grip'));
    grip.addEventListener('dragstart', e => { e.dataTransfer.setData(NOTE_MIME, n.id); e.dataTransfer.effectAllowed = 'move'; card.classList.add('dragging'); });
    grip.addEventListener('dragend', () => card.classList.remove('dragging'));
    const card = el('article', null, { class: `note ${n.status}`, 'data-id': n.id }, grip, box, el('div', null, { class: 'note-main' }, title, body, by), tools);
    return card;
  }
  // Dropping on a card puts the note above or below it; on a column's empty space, at its end.
  function dropZone(list, items, assigneeId) {
    list.addEventListener('dragover', e => { if (e.dataTransfer.types.includes(NOTE_MIME)) { e.preventDefault(); list.classList.add('over'); } });
    list.addEventListener('dragleave', e => { if (!list.contains(e.relatedTarget)) list.classList.remove('over'); });
    list.addEventListener('drop', run(async e => {
      list.classList.remove('over'); const id = e.dataTransfer.getData(NOTE_MIME); if (!id) return;
      const target = e.target.closest('.note'), rest = items.filter(n => n.id !== id);
      let at = rest.length;
      if (target && target.dataset.id !== id) { const r = target.getBoundingClientRect(); at = rest.findIndex(n => n.id === target.dataset.id) + (e.clientY > r.top + r.height / 2 ? 1 : 0); }
      const before = rest[at - 1]?.position, after = rest[at]?.position;
      const position = before === undefined && after === undefined ? 1 : before === undefined ? after - 1 : after === undefined ? before + 1 : (before + after) / 2;
      await save({ id }, { position, ...(notesView === 'company' ? { assigneeId } : {}) }); await workspace();
    }));
  }
  if (notesView === 'private') {
    const list = el('div', null, { class: 'notes-list' });
    if (!visible.length) list.append(el('div', 'Nothing here yet. Type above and press Return.', { class: 'empty' }));
    for (const n of visible) list.append(noteCard(n));
    dropZone(list, visible, null);
    main.append(el('div', null, { class: 'notes-solo' }, adder(), list));
    main.querySelector('.adder input').focus();
    return;
  }
  const board = el('div', null, { class: 'board' });
  const columns = [...members.map(m => ({ id: m.id, label: m.id === me.user.id ? `${m.name} (you)` : m.name, avatar: initials(m.name) })), { id: null, label: 'Unassigned' }];
  for (const col of columns) {
    const items = visible.filter(n => (n.assigneeId || null) === col.id);
    const list = el('div', null, { class: 'notes-list' });
    for (const n of items) list.append(noteCard(n));
    dropZone(list, items, col.id);
    board.append(el('section', null, { class: 'column' },
      el('header', null, {}, col.avatar ? el('span', col.avatar, { class: 'avatar sm' }) : null, el('h3', col.label), el('span', String(items.filter(n => n.status === 'open').length), { class: 'count' })),
      canTeam ? adder(col.id ? { assigneeId: col.id } : {}, col.id === me.user.id ? 'Add for yourself…' : col.id ? `Add for ${col.label.split(' ')[0]}…` : 'Add…') : null,
      list));
  }
  main.append(board);
}

async function conversations(main, company) {
  const { conversations: list } = await api(`${base()}/conversations`);
  const canWrite = company.role !== 'viewer';
  let action = null;
  if (canWrite) action = (() => { const b = button('New conversation', async () => { activeConversation = { draft: true }; await workspace(); }); b.prepend(icon('plus')); return b; })();
  head(main, 'Conversations', 'History shared from TerminAI sessions. This server doesn’t run any AI.', action);
  if (activeConversation && !activeConversation.draft) activeConversation = list.find(c => c.id === activeConversation.id) || null;
  if (!activeConversation && list.length) activeConversation = list[0];

  const rail = el('div', null, { class: 'list' });
  if (!list.length) rail.append(el('div', 'No conversations yet.', { class: 'empty' }));
  for (const c of list) {
    const row = el('div', null, { class: 'row', tabindex: '0', 'aria-current': String(c.id === activeConversation?.id) },
      el('div', null, { class: 'grow' }, el('strong', c.title), el('small', new Date(c.updatedAt || c.createdAt).toLocaleDateString())),
      el('span', c.visibility === 'owner' ? 'Private' : 'Shared', { class: `badge ${c.visibility === 'owner' ? '' : 'on'}` }));
    const open = run(async () => { activeConversation = c; await workspace(); });
    row.addEventListener('click', open); row.addEventListener('keydown', e => { if (e.key === 'Enter') open(e); });
    rail.append(row);
  }
  const pane = el('div', null, { class: 'stack' });
  main.append(el('div', null, { class: 'convo' }, rail, pane));

  if (activeConversation?.draft) {
    const f = form(async data => { const result = await api(`${base()}/conversations`, 'POST', data); activeConversation = result.conversation; await workspace(); });
    field(f, 'Title', 'title');
    field(f, 'Who can see it', 'visibility', 'text', company.defaultVisibility, company.allowCompanySharing ? ['owner', 'company'] : ['owner']);
    const actions = el('div', null, { class: 'actions' }); submit(actions, 'Create');
    actions.append(button('Cancel', async () => { activeConversation = null; await workspace(); }, 'secondary')); f.append(actions);
    pane.append(card('New conversation', '“Owner” keeps it private to you; “company” shares it with the roles you choose.', f));
    return;
  }
  if (!activeConversation) { pane.append(el('div', null, { class: 'card empty' }, el('p', 'Create a conversation, or share one from TerminAI’s Sync panel.'))); return; }

  const thread = el('div', null, { class: 'thread' });
  const shell = card(activeConversation.title, activeConversation.visibility === 'owner' ? 'Private to its owner' : `Shared with ${activeConversation.allowedRoles.join(', ') || 'the company'}`, thread);
  pane.append(shell);
  async function load(after) {
    const result = await api(`${base()}/conversations/${activeConversation.id}/messages${after ? `?after=${after}` : ''}`);
    if (!after && !result.messages.length) thread.append(el('p', 'No messages yet.', { class: 'small' }));
    for (const m of result.messages)
      thread.append(el('article', null, { class: `msg ${m.kind}` },
        el('header', null, {}, el('strong', m.authorName || m.authorId), el('span', m.kind), m.createdAt && el('span', new Date(m.createdAt).toLocaleString())),
        el('div', m.content)));
    if (result.hasMore) { const more = button('Load more', async () => { more.remove(); await load(result.nextCursor); }, 'secondary'); thread.append(more); }
  }
  await load();
  if (canWrite) {
    const f = form(async (data, f) => {
      await api(`${base()}/conversations/${activeConversation.id}/messages`, 'POST', { content: data.content, kind: 'user', clientMessageId: crypto.randomUUID() });
      await workspace(); message('Message saved.');
    });
    const text = field(f, 'Add a message', 'content', 'textarea');
    text.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) f.requestSubmit(); });
    const actions = el('div', null, { class: 'actions' }); submit(actions, 'Send'); actions.append(el('small', '⌘ Return')); f.append(actions);
    shell.append(f);
  }
  if (activeConversation.ownerId === me.user.id && canWrite) {
    const f = form(async (data, f) => {
      await api(`${base()}/conversations/${activeConversation.id}`, 'PATCH', { title: data.title, visibility: data.visibility, allowedRoles: new FormData(f).getAll('allowedRoles') });
      await workspace(); message('Sharing saved.');
    });
    const two = el('div', null, { class: 'fields' });
    field(two, 'Title', 'title', 'text', activeConversation.title);
    field(two, 'Who can see it', 'visibility', 'text', activeConversation.visibility, company.allowCompanySharing ? ['owner', 'company'] : ['owner']);
    f.append(two, el('label', 'Roles that can read it when shared'), chips('allowedRoles', roles, r => activeConversation.allowedRoles.includes(r)));
    submit(f, 'Save sharing', 'secondary');
    pane.append(card('Sharing', 'Only you, the owner, can change this.', f));
  }
}

async function team(main, company) {
  const owner = company.role === 'owner';
  const { members } = await api(`${base()}/members`), { invites } = await api(`${base()}/invites`);
  head(main, 'People', `${members.length} ${members.length === 1 ? 'person' : 'people'} in ${company.name}`);

  const list = el('div', null, { class: 'list' });
  for (const member of members) {
    const row = el('div', null, { class: 'row' }, el('span', initials(member.name), { class: 'avatar' }),
      el('div', null, { class: 'grow' }, el('strong', member.name + (member.id === me.user.id ? ' (you)' : '')), el('small', member.email)));
    if (owner || !['owner', 'admin'].includes(member.role)) {
      const f = form(async () => { await api(`${base()}/members/${member.id}`, 'PATCH', Object.fromEntries(new FormData(f))); await refresh(); message(`${member.name} updated.`); });
      f.className = 'actions';
      const role = field(f, '', 'role', 'text', member.role, owner ? roles : ['member', 'viewer']);
      const cls = field(f, '', 'classification', 'text', member.classification, classes);
      role.setAttribute('aria-label', 'Role'); cls.setAttribute('aria-label', 'Classification');
      for (const s of [role, cls]) s.addEventListener('change', () => f.requestSubmit());
      f.append(button('Remove', async () => {
        if (confirm(`Remove ${member.name} from ${company.name}?`)) { await api(`${base()}/members/${member.id}`, 'DELETE'); await refresh(); }
      }, 'danger'));
      row.append(f);
    } else row.append(el('span', member.role, { class: 'badge on' }), el('span', member.classification, { class: 'badge' }));
    list.append(row);
  }

  const result = el('div');
  const invite = form(async data => {
    const r = await api(`${base()}/invites`, 'POST', data);
    const copy = button('Copy', async () => { await navigator.clipboard.writeText(r.inviteUrl); message('Link copied.'); }, 'secondary');
    result.replaceChildren(el('div', null, { class: 'stack' }, el('small', 'Send this link to them. It works once, expires in 48 hours and is only shown now.'),
      el('div', null, { class: 'link-box' }, el('span', r.inviteUrl), copy)));
  });
  const fields = el('div', null, { class: 'fields' });
  field(fields, 'Email', 'email', 'email');
  field(fields, 'Role', 'role', 'text', 'member', owner ? ['admin', 'member', 'viewer'] : ['member', 'viewer']);
  field(fields, 'Classification', 'classification', 'text', 'general', classes);
  invite.append(fields); submit(invite, 'Create invitation link');

  const pending = el('div', null, { class: 'list' });
  if (!invites.length) pending.append(el('div', 'No invitations yet.', { class: 'empty' }));
  for (const inv of invites) {
    const state = inv.accepted_at ? 'accepted' : inv.revoked_at ? 'revoked' : new Date(inv.expires_at) < new Date() ? 'expired' : 'pending';
    const row = el('div', null, { class: 'row' }, el('div', null, { class: 'grow' }, el('strong', inv.email), el('small', `${inv.role} · ${inv.classification || ''}`)),
      el('span', state[0].toUpperCase() + state.slice(1), { class: `badge ${state === 'accepted' ? 'ok' : state === 'pending' ? 'warn' : ''}` }));
    if (state === 'pending' && (owner || inv.role !== 'admin')) row.append(button('Revoke', async () => { await api(`${base()}/invites/${inv.id}`, 'DELETE'); await workspace(); }, 'danger'));
    pending.append(row);
  }
  main.append(el('div', null, { class: 'stack' }, list, card('Invite someone', null, invite, result), el('h2', 'Invitations'), pending));
}

async function tools(main, company) {
  const admin = ['owner', 'admin'].includes(company.role), { catalog } = await api(`${base()}/catalog`);
  head(main, 'Tools', 'MCP tools TerminAI sets up on each Mac, by role and job. Nothing is installed or run here.');
  const stack = el('div', null, { class: 'stack' });
  for (const tool of catalog) {
    const c = card(null, null,
      el('div', null, { class: 'card-head' },
        el('div', null, {}, el('h2', tool.name), el('p', tool.description, { class: 'small' })),
        el('span', tool.assigned ? 'Assigned to you' : 'Not assigned', { class: `badge ${tool.assigned ? 'ok' : ''}` })),
      el('a', 'Setup docs ↗', { href: tool.docsUrl, target: '_blank', rel: 'noopener noreferrer', class: 'small' }));
    if (tool.setupRequired) c.append(el('p', 'Needs the Google Ads MCP endpoint configured on the server first.', { class: 'small' }));
    if (admin) {
      const f = form(async () => {
        const data = new FormData(f);
        await api(`${base()}/catalog/${tool.id}/assignments`, 'PUT', { roles: data.getAll('role'), classifications: data.getAll('classification') });
        await workspace(); message(`${tool.name} assignments saved.`);
      });
      const has = (type, v) => tool.assignments.some(a => a.subject_type === type && a.subject === v);
      f.append(el('label', 'Roles'), chips('role', roles, v => has('role', v)), el('label', 'Jobs'), chips('classification', classes, v => has('classification', v)));
      submit(f, 'Save', 'secondary'); c.append(f);
    }
    stack.append(c);
  }
  main.append(stack);
}

async function settings(main, company) {
  head(main, 'Workspace settings', 'Only the owner sees this page.');
  const f = form(async data => {
    await api(base(), 'PATCH', { name: data.name, defaultVisibility: data.defaultVisibility, allowCompanySharing: data.allowCompanySharing === 'yes' });
    await refresh(); message('Settings saved.');
  });
  field(f, 'Workspace name', 'name', 'text', company.name);
  const two = el('div', null, { class: 'fields' });
  field(two, 'New conversations are', 'defaultVisibility', 'text', company.defaultVisibility, ['owner', 'company']);
  field(two, 'Allow sharing with everyone here', 'allowCompanySharing', 'text', company.allowCompanySharing ? 'yes' : 'no', ['yes', 'no']);
  f.append(two, el('small', 'Turning sharing off makes every shared conversation private at once. Turning it back on doesn’t re-share them.'));
  submit(f, 'Save settings');
  main.append(card(null, null, f));
}

async function account(main) {
  head(main, 'Account', me.user.email);
  const { sessions } = await api('/api/auth/sessions');
  const list = el('div', null, { class: 'list' });
  for (const s of sessions)
    list.append(el('div', null, { class: 'row' },
      el('div', null, { class: 'grow' }, el('strong', s.client === 'desktop' ? 'TerminAI desktop' : 'Browser'), el('small', `Signed in ${new Date(s.created_at).toLocaleString()}`)),
      s.current && el('span', 'This session', { class: 'badge on' }),
      button(s.current ? 'Sign out' : 'Revoke', async () => { await api(`/api/auth/sessions/${s.id}`, 'DELETE'); if (s.current) location.reload(); else await workspace(); }, 'danger')));
  const f = form(async data => { await api('/api/auth/password', 'POST', data); location.reload(); });
  const two = el('div', null, { class: 'fields' });
  const cur = field(two, 'Current password', 'currentPassword', 'password'); cur.removeAttribute('minlength');
  field(two, 'New password', 'password', 'password'); f.append(two);
  submit(f, 'Change password', 'secondary');
  f.append(el('small', 'This signs you out everywhere, TerminAI included.'));
  const link = el('div', null, { class: 'row' }, el('div', null, { class: 'grow' }, el('strong', 'Sign in your iPhone or another Mac'),
    el('small', 'Tap “Sign in with browser” in the app, then type the code it shows here.')), button('Enter a code', () => { deviceCode = ''; showDevice(); }));
  main.append(el('div', null, { class: 'stack' }, el('h2', 'Signed-in devices'), list, card(null, null, link), card('Password', null, f)));
}

run(start)();
