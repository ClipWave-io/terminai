import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { migrate } from '../src/db.js';
import { createApp } from '../src/app.js';
const databaseUrl = process.env.MANAGER_TEST_DATABASE_URL;
// Sofia joins by a link limited to ManyMotions.org: she gets only that product, its chat, and none of the team chat.
test('invites limited to a product, and product chats', { skip: !databaseUrl }, async t => {
  const schema = `manager_test_${randomUUID().replaceAll('-', '')}`;
  const control = new pg.Pool({ connectionString: databaseUrl }); await control.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 10 });
  const server = createServer(createApp(pool, { publicOrigin: 'http://localhost:8080', trustProxyHops: 0 }));
  t.after(async () => { await new Promise(r => server.close(r)); await pool.end(); await control.query(`DROP SCHEMA ${schema} CASCADE`); await control.end(); });
  await migrate(pool); await new Promise(r => server.listen(0, '127.0.0.1', r));
  const request = async (path, { token, method = 'GET', data } = {}) => {
    const r = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(data ? { 'Content-Type': 'application/json' } : {}) }, body: data ? JSON.stringify(data) : undefined });
    return { status: r.status, body: await r.json() };
  };
  const pw = 'long products test password';
  const ilai = (await request('/api/auth/signup', { method: 'POST', data: { name: 'Ilai', email: 'ilai@example.test', companyName: 'BUILD', password: pw, client: 'desktop' } })).body;
  const company = (await request('/api/me', { token: ilai.token })).body.companies[0].id, base = `/api/companies/${company}`;
  // A link that makes a member limited to ManyMotions.org.
  const link = await request(`${base}/invites/link`, { token: ilai.token, method: 'POST', data: { role: 'member', products: ['ManyMotions.org'] } });
  assert.equal(link.status, 200); assert.deepEqual(link.body.products, ['ManyMotions.org']);
  const token = link.body.inviteUrl.split('#invite=')[1];
  // Before anyone joins, the open invite already makes the ManyMotions.org chat appear for the admin.
  assert.deepEqual((await request(`${base}/chat/channels`, { token: ilai.token })).body.channels, ['ManyMotions.org']);
  // Every product in the To-do has its chat too, before anyone is limited to it.
  await request(`${base}/tasks/t-coldwave`, { token: ilai.token, method: 'PUT', data: { task: { id: 't-coldwave', title: 'Launch', status: 'open', product: 'ColdWave' } } });
  assert.deepEqual((await request(`${base}/chat/channels`, { token: ilai.token })).body.channels, ['ColdWave', 'ManyMotions.org']);
  const sofia = (await request('/api/auth/accept-invite', { method: 'POST', data: { token, name: 'Sofia', email: 'sofia@example.test', password: pw, client: 'desktop' } })).body;
  const members = (await request(`${base}/members`, { token: ilai.token })).body.members;
  assert.deepEqual(members.find(m => m.name === 'Sofia').products, ['ManyMotions.org'], 'joins limited to the product');
  // An email invite with products works the same way.
  const inv = await request(`${base}/invites`, { token: ilai.token, method: 'POST', data: { email: 'fritz@example.test', role: 'viewer', products: ['ManyMotions.org'] } });
  const fritz = (await request('/api/auth/accept-invite', { method: 'POST', data: { token: inv.body.token, name: 'Fritz', password: pw, client: 'desktop' } })).body;
  const fm = (await request(`${base}/members`, { token: ilai.token })).body.members.find(m => m.name === 'Fritz');
  assert.equal(fm.role, 'viewer'); assert.deepEqual(fm.products, ['ManyMotions.org']);
  // An admin invite never carries products.
  const adminLink = await request(`${base}/invites/link`, { token: ilai.token, method: 'POST', data: { role: 'admin', products: ['ManyMotions.org'] } });
  assert.equal(adminLink.body.products, null);
  // Chats: Ilai writes in the team chat and in the product chat; Sofia sees only the product one.
  await request(`${base}/chat`, { token: ilai.token, method: 'POST', data: { body: 'team only: salaries' } });
  await request(`${base}/chat`, { token: ilai.token, method: 'POST', data: { body: 'Welcome to .org!', channel: 'ManyMotions.org' } });
  assert.equal((await request(`${base}/chat`, { token: sofia.token })).status, 403, 'no team chat for a product-only member');
  const org = (await request(`${base}/chat?channel=ManyMotions.org`, { token: sofia.token })).body.messages.map(m => m.body);
  assert.deepEqual(org, ['Welcome to .org!']);
  assert.equal((await request(`${base}/chat?channel=Abracadabrax`, { token: sofia.token })).status, 403, 'no other product chat');
  assert.equal((await request(`${base}/chat`, { token: sofia.token, method: 'POST', data: { body: 'hi', channel: 'ManyMotions.org' } })).status, 200);
  assert.equal((await request(`${base}/chat`, { token: sofia.token, method: 'POST', data: { body: 'sneaky' } })).status, 403);
  const ch = (await request(`${base}/chat/channels`, { token: sofia.token })).body;
  assert.equal(ch.team, false); assert.deepEqual(ch.channels, ['ManyMotions.org']);
  const chIlai = (await request(`${base}/chat/channels`, { token: ilai.token })).body;
  assert.equal(chIlai.team, true); assert.ok(chIlai.channels.includes('ManyMotions.org'));
  assert.deepEqual((await request(`${base}/chat`, { token: ilai.token })).body.messages.map(m => m.body), ['team only: salaries'], 'the team chat keeps its own messages');
  assert.equal((await request(`${base}/chat`, { token: fritz.token, method: 'POST', data: { body: 'x', channel: 'ManyMotions.org' } })).status, 403, 'a viewer reads only');
  // Task columns: a member cannot take a column someone else holds; an admin can reassign it.
  assert.equal((await request(`${base}/tasks/people`, { token: ilai.token, method: 'PUT', data: { key: 'ilai' } })).status, 200);
  assert.equal((await request(`${base}/tasks/people`, { token: sofia.token, method: 'PUT', data: { key: 'ilai' } })).status, 403, 'not her column');
  assert.equal((await request(`${base}/tasks/people`, { token: sofia.token, method: 'PUT', data: { key: 'livio' } })).status, 200, 'a free column is fine');
  // Share links: a file in a folder, shared by its uploader, opens for anyone with the link until stopped.
  const port = server.address().port;
  const up = await (await fetch(`http://127.0.0.1:${port}${base}/files?name=Deck.pdf&type=application/pdf&folder=Sales%2FUniversities`, { method: 'POST', headers: { Authorization: `Bearer ${ilai.token}`, 'Content-Type': 'application/octet-stream' }, body: Buffer.from('%PDF-1.4 deck') })).json();
  assert.equal(up.file.folder, 'Sales/Universities');
  assert.equal((await request(`${base}/files/${up.file.id}/share`, { token: sofia.token, method: 'POST' })).status, 403, 'only its uploader or an admin');
  const shareUrl = (await request(`${base}/files/${up.file.id}/share`, { token: ilai.token, method: 'POST' })).body.url;
  const path = new URL(shareUrl).pathname, open = await fetch(`http://127.0.0.1:${port}${path}`);
  assert.equal(open.status, 200); assert.equal(open.headers.get('content-type'), 'application/pdf'); assert.match(open.headers.get('content-disposition'), /^inline/); assert.equal(await open.text(), '%PDF-1.4 deck');
  assert.equal((await request(`${base}/files`, { token: ilai.token })).body.files.find(f => f.id === up.file.id).shared, true);
  await request(`${base}/files/${up.file.id}/share`, { token: ilai.token, method: 'DELETE' });
  assert.equal((await fetch(`http://127.0.0.1:${port}${path}`)).status, 404, 'stopped');
  // The app learns which products someone was limited to (their To-do and Notes list them).
  assert.deepEqual((await request('/api/me', { token: sofia.token })).body.companies[0].products, ['ManyMotions.org']);
  assert.equal((await request('/api/me', { token: ilai.token })).body.companies[0].products, null);
  // The work log is everyone's: Fritz has no To-do column and logs under his own key; Sofia logs her day, the admin reads it with her name.
  assert.equal((await request(`${base}/worklog/2026-11-13`, { token: sofia.token, method: 'PUT', data: { data: { workingMinutes: 42, projects: [], conversations: [] } } })).status, 200);
  const day = (await request(`${base}/worklog/2026-11-13`, { token: ilai.token })).body;
  // (Sofia took the free 'livio' column above, so her log is under it; without a column it would be 'u:<her id>'.)
  const key = Object.keys(day.people).find(k => day.names[k] === 'Sofia');
  assert.ok(key && day.people[key].workingMinutes === 42, JSON.stringify(day));
  assert.equal((await request(`${base}/worklog/2026-11-13`, { token: sofia.token })).body.me, key, 'Sofia learns her own key');
  assert.equal((await request(`${base}/worklog/2026-11-13`, { token: fritz.token, method: 'PUT', data: { data: { workingMinutes: 7, projects: [], conversations: [] } } })).status, 200);
  const day2 = (await request(`${base}/worklog/2026-11-13`, { token: ilai.token })).body, fk = Object.keys(day2.people).find(k => k.startsWith('u:'));
  assert.ok(fk && day2.names[fk] === 'Fritz' && day2.people[fk].workingMinutes === 7, JSON.stringify(day2));
  // Every member has a To-do key: the partners their column, everyone else 'u:<id>'. Nora joins limited to ManyMotions.org, with no column.
  const noraLink = await request(`${base}/invites/link`, { token: ilai.token, method: 'POST', data: { role: 'member', products: ['ManyMotions.org'] } });
  const nora = (await request('/api/auth/accept-invite', { method: 'POST', data: { token: noraLink.body.inviteUrl.split('#invite=')[1], name: 'Nora Keller', email: 'nora@example.test', password: pw, client: 'desktop' } })).body;
  const noraId = (await request('/api/me', { token: nora.token })).body.user.id, noraKey = `u:${noraId}`;
  const noraTasks = (await request(`${base}/tasks`, { token: nora.token })).body;
  assert.equal(noraTasks.me, noraKey, 'a member without a column is u:<id>');
  assert.equal(noraTasks.column, null);
  assert.equal((await request(`${base}/tasks`, { token: ilai.token })).body.me, 'ilai');
  // The members list: everyone in the workspace, with their key and products.
  const listed = Object.fromEntries(noraTasks.members.map(m => [m.name, m]));
  assert.equal(listed.Ilai.key, 'ilai'); assert.equal(listed.Sofia.key, 'livio'); assert.equal(listed['Nora Keller'].key, noraKey);
  assert.match(listed.Fritz.key, /^u:[0-9a-f-]{36}$/); assert.deepEqual(listed['Nora Keller'].products, ['ManyMotions.org']); assert.equal(listed.Ilai.products, null);
  // A task assigned to a member's column; a key that is no member's is refused.
  assert.equal((await request(`${base}/tasks/t-org`, { token: ilai.token, method: 'PUT', data: { task: { id: 't-org', title: 'Org landing', status: 'open', product: 'ManyMotions.org', assignee: noraKey, createdBy: 'ilai', updatedBy: 'ilai' } } })).status, 200);
  assert.equal((await request(`${base}/tasks/t-bad`, { token: ilai.token, method: 'PUT', data: { task: { id: 't-bad', title: 'x', status: 'open', product: '', assignee: `u:${randomUUID()}` } } })).status, 400, 'not a member');
  // Nora sees only her product's tasks, and signs her own edits.
  const seen = (await request(`${base}/tasks`, { token: nora.token })).body.tasks;
  assert.deepEqual(seen.map(t => t.id), ['t-org']); assert.equal(seen[0].assignee, noraKey);
  const edit = await request(`${base}/tasks/t-org`, { token: nora.token, method: 'PUT', data: { task: { ...seen[0], status: 'doing', updatedBy: 'ilai' } } });
  assert.equal(edit.status, 200); assert.equal(edit.body.task.updatedBy, noraKey, 'signed with her key'); assert.equal(edit.body.task.createdBy, 'ilai', 'the author stays');
  // Another product's task stays out of her reach, even by its id.
  assert.equal((await request(`${base}/tasks/t-coldwave`, { token: nora.token, method: 'PUT', data: { task: { id: 't-coldwave', title: 'Mine now', status: 'open', product: 'ManyMotions.org' } } })).status, 403);
  assert.equal((await request(`${base}/tasks/t-coldwave`, { token: nora.token, method: 'DELETE' })).status, 403);
  assert.ok((await request(`${base}/tasks`, { token: ilai.token })).body.tasks.some(t => t.id === 't-coldwave' && t.title === 'Launch'));
});
