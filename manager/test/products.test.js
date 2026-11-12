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
});
