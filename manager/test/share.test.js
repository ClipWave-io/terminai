import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { migrate } from '../src/db.js';
import { createApp } from '../src/app.js';
import { canReadConversation, canWriteConversation } from '../src/security.js';

test('shared with: the listed person reads it; a bot key of that person never does', () => {
  const c = { owner_id: 'ada', visibility: 'owner', allowed_roles: ['owner', 'admin', 'member'], shared_with: ['pat'] };
  assert.equal(canReadConversation(c, { role: 'member' }, 'pat'), true);
  assert.equal(canReadConversation(c, { role: 'member' }, 'pat', true), false, 'a bot key, even of the listed person');
  assert.equal(canReadConversation(c, { role: 'admin' }, 'adm'), false, 'admins gain nothing');
  assert.equal(canReadConversation(c, { role: 'member' }, 'nm'), false);
  assert.equal(canWriteConversation(c, { role: 'viewer' }, 'pat'), false);
  assert.equal(canReadConversation({ ...c, shared_with: undefined }, { role: 'member' }, 'pat'), false);
});

const databaseUrl = process.env.MANAGER_TEST_DATABASE_URL;
test('real PostgreSQL: Share with… one conversation with one person', { skip: !databaseUrl }, async t => {
  const parsed = new URL(databaseUrl);
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname), 'Only an isolated local test database is permitted.');
  assert.ok(parsed.pathname.startsWith('/terminai_test_'), 'Test database must start terminai_test_.');
  const schema = `manager_test_${randomUUID().replaceAll('-', '')}`;
  const control = new pg.Pool({ connectionString: databaseUrl }); await control.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 10 });
  let server;
  t.after(async () => { if (server) await new Promise(r => server.close(r)); await pool.end(); await control.query(`DROP SCHEMA ${schema} CASCADE`); await control.end(); });
  await migrate(pool); await migrate(pool);
  server = createServer(createApp(pool, { publicOrigin: 'http://localhost:8080', trustProxyHops: 0 })); await new Promise(r => server.listen(0, '127.0.0.1', r));
  const request = async (path, { token, method = 'GET', data } = {}) => {
    const r = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(data ? { 'Content-Type': 'application/json' } : {}) }, body: data ? JSON.stringify(data) : undefined });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  const password = 'long share test password';
  const signup = async (name, email, companyName) => { const r = await request('/api/auth/signup', { method: 'POST', data: { name, email, companyName, password, client: 'desktop' } }); assert.equal(r.status, 200); return r.body; };
  const ada = await signup('Ada', 'ada@example.test', 'Alpha');
  // Pat has an organisation of their own (Gamma), and joins Ada's too.
  const pat = await signup('Pat', 'pat@example.test', 'Gamma');
  const alpha = (await request('/api/me', { token: ada.token })).body.companies[0].id, A = `/api/companies/${alpha}`;
  const gamma = (await request('/api/me', { token: pat.token })).body.companies[0].id, G = `/api/companies/${gamma}`;
  const join = async (role, name, email, existing) => {
    const link = (await request(`${A}/invites/link`, { token: ada.token, method: 'POST', data: { role } })).body.token;
    const r = await request('/api/auth/accept-invite', { method: 'POST', data: { token: link, name, email, password, client: 'desktop' } }); assert.equal(r.status, 200, JSON.stringify(r.body));
    return existing ?? r.body;
  };
  await join('member', 'Pat', 'pat@example.test', pat);
  const adm = await join('admin', 'Adm', 'adm@example.test'), nm = await join('member', 'Nm', 'nm@example.test');
  // Everyone may see others' sessions (the loosest setting), so only the share decides.
  assert.equal((await request(A, { token: ada.token, method: 'PATCH', data: { sessionVisibility: 'all' } })).status, 200);

  // Ada's tab, Only me (owner), then shared with Pat alone.
  const tab = (await request(`${A}/conversations/tab/key-share`, { token: ada.token, method: 'PUT', data: { title: 'For Pat', visibility: 'owner' } })).body.conversation;
  await request(`${A}/conversations/${tab.id}/messages`, { token: ada.token, method: 'POST', data: { kind: 'user', content: 'the private turn' } });
  const share = people => request(`${A}/conversations/${tab.id}/share`, { token: ada.token, method: 'PUT', data: { people } });
  // Not before it is shared.
  assert.equal((await request(`${A}/conversations/${tab.id}/messages`, { token: pat.token })).status, 404);
  // Only members of the organisation, only by its owner, never by a bot key.
  assert.equal((await share([randomUUID()])).status, 400, 'a stranger');
  assert.equal((await request(`${A}/conversations/${tab.id}/share`, { token: adm.token, method: 'PUT', data: { people: [adm.user.id] } })).status, 404, 'an admin cannot even see it');
  assert.equal((await request(`${A}/conversations/${tab.id}/share`, { token: pat.token, method: 'PUT', data: { people: [pat.user.id] } })).status, 404);
  const shared = await share([pat.user.id]); assert.equal(shared.status, 200);
  assert.deepEqual(shared.body.conversation.sharedWith, [pat.user.id]);

  // Pat lists it, reads it, sees it is shared with them (not with whom else).
  const listed = (await request(`${A}/conversations`, { token: pat.token })).body.conversations.find(c => c.id === tab.id);
  assert.ok(listed && listed.sharedWithYou && !listed.sharedWith);
  assert.equal((await request(`${A}/conversations/${tab.id}/messages`, { token: pat.token })).body.messages[0].content, 'the private turn');
  // Pat may post a note, never a turn into Ada's agent's mouth.
  assert.equal((await request(`${A}/conversations/${tab.id}/messages`, { token: pat.token, method: 'POST', data: { kind: 'user', content: 'x' } })).status, 403);

  // Security: a member not listed, an admin, and a bot key (Pat's own) read nothing of it.
  for (const [who, token] of [['member not listed', nm.token], ['admin', adm.token]]) {
    assert.ok(!(await request(`${A}/conversations`, { token })).body.conversations.some(c => c.id === tab.id), `${who} does not list it`);
    assert.equal((await request(`${A}/conversations/${tab.id}/messages`, { token })).status, 404, `${who} cannot read it`);
    assert.equal((await request(`${A}/agent`, { token, method: 'POST', data: { to: tab.id, content: 'hi' } })).status, 404, `${who} cannot message it`);
  }
  const bot = (await request(`${A}/bots`, { token: pat.token, method: 'POST', data: { name: 'Patbot' } })).body.key;
  const asBot = (path, o = {}) => fetch(`http://127.0.0.1:${server.address().port}${path}`, { method: o.method || 'GET', headers: { Authorization: `Bearer ${bot}`, ...(o.data ? { 'Content-Type': 'application/json' } : {}) }, body: o.data ? JSON.stringify(o.data) : undefined }).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }));
  assert.ok(!(await asBot(`${A}/conversations`)).body.conversations.some(c => c.id === tab.id), 'bot does not list it');
  assert.equal((await asBot(`${A}/conversations/${tab.id}/messages`)).status, 404, 'bot cannot read it');
  assert.equal((await asBot(`${A}/agent`, { method: 'POST', data: { to: tab.id, content: 'hi' } })).status, 404, 'bot cannot message it');

  // Pat's agent, in a tab of Pat's own organisation (Gamma, not shared with Ada), messages the shared conversation.
  const patTab = (await request(`${G}/conversations/tab/pat-tab`, { token: pat.token, method: 'PUT', data: { title: 'Pat private', visibility: 'owner' } })).body.conversation;
  const sent = await request(`${G}/agent`, { token: pat.token, method: 'POST', data: { to: tab.id, from: patTab.id, content: 'question from Pat' } });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  // It arrives in Ada's inbox of Alpha (the shared conversation's organisation).
  const inbox = (await request(`${A}/agent/inbox`, { token: ada.token })).body.messages.find(m => m.id === sent.body.id);
  assert.ok(inbox && inbox.from === patTab.id && !inbox.fromTitle, 'from Pat, without the title of their private tab');
  // Ada cannot read Pat's tab, but answers that message into it.
  assert.equal((await request(`${A}/conversations/${patTab.id}/messages`, { token: ada.token })).status, 404);
  assert.equal((await request(`${A}/agent`, { token: ada.token, method: 'POST', data: { to: patTab.id, content: 'unasked' } })).status, 404, 'no message into it without a question');
  const answer = await request(`${A}/agent`, { token: ada.token, method: 'POST', data: { to: patTab.id, content: 'answer from Ada', replyTo: sent.body.id, from: tab.id } });
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  // Pat gets it in Gamma, and sees it from either organisation as a reply to their message.
  assert.ok((await request(`${G}/agent/inbox`, { token: pat.token })).body.messages.some(m => m.content === 'answer from Ada' && m.replyTo === sent.body.id));
  assert.equal((await request(`${G}/agent/${sent.body.id}/replies`, { token: pat.token })).body.replies[0].content, 'answer from Ada');
  // The member not listed cannot use that message to reach Pat's tab.
  assert.equal((await request(`${A}/agent`, { token: nm.token, method: 'POST', data: { to: patTab.id, content: 'x', replyTo: sent.body.id } })).status, 404);
  assert.equal((await request(`${A}/agent/${sent.body.id}/replies`, { token: nm.token })).status, 404);

  // Stop sharing: Pat loses it at once.
  assert.equal((await share([])).status, 200);
  assert.equal((await request(`${A}/conversations/${tab.id}/messages`, { token: pat.token })).status, 404);
  assert.equal((await request(`${G}/agent`, { token: pat.token, method: 'POST', data: { to: tab.id, content: 'still?' } })).status, 404);
  assert.ok(!(await request(`${A}/conversations`, { token: pat.token })).body.conversations.some(c => c.id === tab.id));
});
