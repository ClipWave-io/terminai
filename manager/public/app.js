const app = document.querySelector('#app'), notice = document.querySelector('#notice');
const roles = ['owner', 'admin', 'member', 'viewer'], classes = ['general', 'developer', 'analyst', 'marketing'];
let me, companyId, page = 'overview', activeConversation, fieldId = 0, noticeTimer;
const hash = new URLSearchParams(location.hash.slice(1));
const inviteToken = hash.get('invite'), setupToken = hash.get('setup');
if (inviteToken || setupToken) history.replaceState(null, '', '/');

// ---- small DOM helpers
function el(tag, value, attributes = {}, ...children) {
  const node = document.createElement(tag);
  if (value !== undefined && value !== null) node.textContent = value;
  for (const [key, v] of Object.entries(attributes)) node.setAttribute(key, v);
  node.append(...children.filter(Boolean));
  return node;
}
const ICONS = {
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
async function refresh() { me = await api('/api/me'); await workspace(); }

// ---- sign in, first setup, invitation
function authPage(title, subtitle, f) {
  const art = el('aside', null, { class: 'auth-art' },
    brand(),
    el('div', null, {},
      el('h2', 'Your team’s AI terminals, in one place.'),
      el('p', 'Shared conversations, approved tools and roles for every Claude Code and Codex session your company runs.', { class: 'dim' }),
      el('div', null, { class: 'term' },
        el('div', null, { class: 'term-bar' }, el('i'), el('i'), el('i')),
        el('div', null, { class: 'term-body' },
          line('$ ', 'terminai team join', ''), line('', '✓ ', 'Signed in to your company'),
          line('', '✓ ', 'Google Ads and browser tools ready'), line('', '✓ ', '3 shared conversations')))),
    el('small', 'Agents run on each person’s Mac. This server only stores accounts, access and shared history.'));
  function line(prompt, strong, rest) {
    const d = el('div'); if (prompt) d.append(prompt);
    d.append(prompt ? el('b', strong) : el('em', strong)); if (rest) d.append(rest); return d;
  }
  const main = el('main', null, { class: 'auth-main' }, el('div', null, { class: 'auth-card' },
    el('header', null, {}, el('h1', title), el('p', subtitle, { class: 'dim' })), f));
  app.replaceChildren(el('div', null, { class: 'auth' }, art, main));
  f.querySelector('input')?.focus();
}
async function start() {
  const setup = await api('/api/setup');
  try { me = await api('/api/me'); } catch { me = null; }
  if (inviteToken) return showInvitation();
  if (me) return workspace();
  if (setup.setupRequired) {
    const f = form(async data => { await api('/api/setup', 'POST', data); await refresh(); });
    field(f, 'Setup token', 'setupToken', 'password', setupToken || '');
    const two = el('div', null, { class: 'fields' }); field(two, 'Your name', 'name'); field(two, 'Company', 'companyName'); f.append(two);
    field(f, 'Email', 'email', 'email'); field(f, 'Password', 'password', 'password');
    submit(f, 'Create company', 'block');
    f.append(el('small', setup.setupEnabled ? 'The setup token is the one-time SETUP_TOKEN in this service’s settings.' : 'Setup is turned off: set SETUP_TOKEN in the server environment first.'));
    return authPage('Set up your company', 'Create the owner account. Everyone else joins by invitation.', f);
  }
  const f = form(async data => { await api('/api/auth/login', 'POST', data); await refresh(); });
  field(f, 'Email', 'email', 'email');
  const password = field(f, 'Password', 'password', 'password'); password.removeAttribute('minlength'); password.autocomplete = 'current-password';
  submit(f, 'Sign in', 'block');
  f.append(el('small', 'New here? Open the invitation link your company admin sent you.'));
  authPage('Welcome back', 'Sign in to your team workspace.', f);
}
function showInvitation() {
  const f = form(async data => { await api('/api/auth/accept-invite', 'POST', { ...data, token: inviteToken }); location.replace('/'); });
  field(f, 'Your name', 'name'); field(f, 'Password', 'password', 'password');
  submit(f, 'Join the team', 'block');
  f.append(el('small', 'Already have an account? Enter its password. Otherwise choose a new one, 12 characters or more.'));
  authPage('You’re invited', 'Join your company on TerminAI.', f);
}

// ---- workspace shell
const PAGES = [
  ['overview', 'Overview', 'overview'], ['conversations', 'Conversations', 'conversations'],
  ['team', 'Team', 'team', c => ['owner', 'admin'].includes(c.role)], ['tools', 'Tools', 'tools'],
  ['settings', 'Company settings', 'settings', c => c.role === 'owner'], ['account', 'Account', 'account'],
];
async function workspace() {
  if (!me.companies.length) {
    const box = el('div', null, { class: 'stack' }, el('p', 'You’re not in a company yet. Ask an owner for an invitation link.', { class: 'dim' }),
      button('Sign out', async () => { await api('/api/auth/logout', 'POST', {}); location.reload(); }, 'secondary'));
    return authPage(`Hi ${me.user.name}`, 'No workspace yet.', box);
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
    switcher = el('select', null, { 'aria-label': 'Company' });
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
  await ({ overview, conversations, team, tools, settings, account })[page](main, company);
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
    stat(list.length, 'conversations'), stat(list.filter(c => c.visibility === 'company').length, 'shared with the company'),
    stat(catalog.filter(t => t.assigned).length, `of ${catalog.length} tools assigned to you`));
  if (['owner', 'admin'].includes(company.role)) {
    const { members } = await api(`${base()}/members`); stats.prepend(stat(members.length, members.length === 1 ? 'member' : 'members'));
  }
  main.append(el('div', null, { class: 'stack' }, stats,
    el('h2', 'Getting started'),
    el('div', null, { class: 'steps' },
      step('Invite your team', 'Create an invitation link under Team. It works once and expires after 48 hours.'),
      step('Pick tools per role', 'Developers get the browser tools, analysts and marketing get Google Ads. Change it under Tools.'),
      step('Sign in from TerminAI', 'On each Mac, click the Team icon in TerminAI and sign in with this site’s address and your account.'),
      step('Share on purpose', 'Conversations are private unless you share them. Nobody’s messages ever run as commands.'))));
  function stat(n, label) { return el('div', null, { class: 'stat' }, el('b', String(n)), el('small', label)); }
  function step(title, text) { return el('div', null, { class: 'card' }, el('h3', title), el('p', text, { class: 'small' })); }
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
  if (!activeConversation) { pane.append(el('div', null, { class: 'card empty' }, el('p', 'Create a conversation, or share one from TerminAI’s Team panel.'))); return; }

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
  head(main, 'Team', `${members.length} ${members.length === 1 ? 'person' : 'people'} in ${company.name}`);

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
  head(main, 'Company settings', 'Only the owner sees this page.');
  const f = form(async data => {
    await api(base(), 'PATCH', { name: data.name, defaultVisibility: data.defaultVisibility, allowCompanySharing: data.allowCompanySharing === 'yes' });
    await refresh(); message('Settings saved.');
  });
  field(f, 'Company name', 'name', 'text', company.name);
  const two = el('div', null, { class: 'fields' });
  field(two, 'New conversations are', 'defaultVisibility', 'text', company.defaultVisibility, ['owner', 'company']);
  field(two, 'Allow sharing with the company', 'allowCompanySharing', 'text', company.allowCompanySharing ? 'yes' : 'no', ['yes', 'no']);
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
  main.append(el('div', null, { class: 'stack' }, el('h2', 'Signed-in devices'), list, card('Password', null, f)));
}

run(start)();
