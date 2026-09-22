import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { migrate } from '../src/db.js';
import { createApp } from '../src/app.js';
const databaseUrl=process.env.MANAGER_TEST_DATABASE_URL;
test('real PostgreSQL: tenant isolation, session revocation, invitations, catalog RBAC, conversation ACL and retries',{skip:!databaseUrl},async t=>{
  const parsed=new URL(databaseUrl);
  assert.ok(['localhost','127.0.0.1','[::1]'].includes(parsed.hostname),'Only an isolated local test database is permitted.');
  assert.ok(parsed.pathname.startsWith('/terminai_test_'),'Test database must start terminai_test_.');
  const schema=`manager_test_${randomUUID().replaceAll('-','')}`;
  const control=new pg.Pool({connectionString:databaseUrl});await control.query(`CREATE SCHEMA ${schema}`);
  const pool=new pg.Pool({connectionString:databaseUrl,options:`-c search_path=${schema}`,max:10});
  const origin='http://localhost:8080',setupToken='test-setup-secret-'.repeat(3);
  let server;
  t.after(async()=>{if(server)await new Promise(r=>server.close(r));await pool.end();await control.query(`DROP SCHEMA ${schema} CASCADE`);await control.end();});
  await migrate(pool);await migrate(pool);
  server=createServer(createApp(pool,{publicOrigin:origin,setupToken,trustProxyHops:0}));await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const base=`http://127.0.0.1:${server.address().port}`;
  async function request(path,{token,method='GET',data,headers={}}={}){
    const response=await fetch(base+path,{method,headers:{...(token?{Authorization:`Bearer ${token}`}:{ }),...(data?{'Content-Type':'application/json'}:{}),...headers},body:data?JSON.stringify(data):undefined});
    return {status:response.status,body:await response.json(),cookie:response.headers.get('set-cookie')};
  }
  const password='long integration password';
  const setup=await request('/api/setup',{method:'POST',data:{setupToken,email:'owner@example.test',name:'Owner',companyName:'One',password,client:'desktop'}});
  assert.equal(setup.status,200);const owner=setup.body.token,ownerId=setup.body.user.id;
  assert.equal((await request('/api/setup',{method:'POST',data:{setupToken,email:'second@example.test',name:'Second',companyName:'Two',password}})).status,409);
  const me=(await request('/api/me',{token:owner})).body,company=me.companies[0].id,companyBase=`/api/companies/${company}`;
  assert.equal(me.companies[0].role,'owner');assert.equal(me.companies[0].defaultVisibility,'owner');
  const defaults=(await request(`${companyBase}/catalog`,{token:owner})).body.catalog;
  assert.equal(defaults.find(e=>e.id==='chrome-devtools').assigned,true);assert.equal(defaults.find(e=>e.id==='google-ads').installation,null);
  async function invite(email,role,classification='general'){
    const created=await request(`${companyBase}/invites`,{token:owner,method:'POST',data:{email,role,classification}});assert.equal(created.status,200);
    const accepted=await request('/api/auth/accept-invite',{method:'POST',data:{token:created.body.token,name:email,password,client:'desktop'}});assert.equal(accepted.status,200);
    return {...accepted.body,inviteToken:created.body.token};
  }
  const member=await invite('member@example.test','member','marketing'),viewer=await invite('viewer@example.test','viewer'),admin=await invite('admin@example.test','admin');
  assert.equal((await request('/api/auth/accept-invite',{method:'POST',data:{token:member.inviteToken,name:'Replay',password}})).status,410);
  assert.equal((await request(`${companyBase}/members/${ownerId}`,{token:owner,method:'DELETE'})).status,409);
  assert.equal((await request(`${companyBase}/members/${ownerId}`,{token:admin.token,method:'PATCH',data:{role:'member'}})).status,403);
  assert.equal((await request(`${companyBase}/invites`,{token:member.token,method:'POST',data:{email:'bad@example.test'}})).status,403);
  const pendingAdmin=await request(`${companyBase}/invites`,{token:owner,method:'POST',data:{email:'future-admin@example.test',role:'admin'}});
  assert.equal(pendingAdmin.status,200);
  assert.equal((await request(`${companyBase}/invites`,{token:admin.token,method:'POST',data:{email:'future-admin@example.test',role:'member'}})).status,403);
  assert.equal((await pool.query('SELECT revoked_at FROM manager_invites WHERE id=$1',[pendingAdmin.body.id])).rows[0].revoked_at,null);
  const memberCatalog=(await request(`${companyBase}/catalog`,{token:member.token})).body.catalog;
  assert.equal(memberCatalog.find(e=>e.id==='google-ads').assigned,true);
  assert.equal((await request(`${companyBase}/catalog/not-allowlisted/assignments`,{token:owner,method:'PUT',data:{roles:['member'],classifications:[],command:'evil'}})).status,404);
  assert.equal((await request(`${companyBase}/catalog/google-ads/assignments`,{token:member.token,method:'PUT',data:{roles:['member'],classifications:[]}})).status,403);
  assert.equal((await request(`${companyBase}/catalog/google-ads/assignments`,{token:owner,method:'PUT',data:{roles:[],classifications:[]}})).status,200);
  assert.equal((await request(`${companyBase}/catalog`,{token:member.token})).body.catalog.find(e=>e.id==='google-ads').installation,null);
  const other=(await request('/api/companies',{token:owner,method:'POST',data:{name:'Other'}})).body.id;
  assert.equal((await request(`/api/companies/${other}/members`,{token:member.token})).status,404);
  async function createConversation(token,visibility='owner',allowedRoles){const result=await request(`${companyBase}/conversations`,{token,method:'POST',data:{title:'Test conversation',visibility,...(allowedRoles?{allowedRoles}:{})}});assert.equal(result.status,200);return result.body.conversation;}
  const privateConversation=await createConversation(member.token),shared=await createConversation(owner,'company');
  assert.equal((await request(`${companyBase}/conversations/${privateConversation.id}`,{token:admin.token})).status,404);
  assert.equal((await request(`${companyBase}/conversations/${privateConversation.id}/messages`,{token:owner})).status,404);
  assert.equal((await request(`/api/companies/${other}/conversations/${shared.id}`,{token:owner})).status,404);
  assert.equal((await request(`${companyBase}/conversations`,{token:viewer.token,method:'POST',data:{title:'No'}})).status,403);
  const msgPath=`${companyBase}/conversations/${shared.id}/messages`,clientMessageId=randomUUID();
  const posts=await Promise.all([1,2].map(()=>request(msgPath,{token:member.token,method:'POST',data:{kind:'user',content:'Hello',clientMessageId}})));
  assert.ok(posts.every(p=>p.status===200));assert.equal(posts[0].body.message.id,posts[1].body.message.id);assert.equal(posts.filter(p=>p.body.deduplicated).length,1);
  assert.equal((await request(msgPath,{token:member.token,method:'POST',data:{content:'Different',clientMessageId}})).status,409);
  assert.equal((await request(msgPath,{token:viewer.token,method:'POST',data:{content:'No'}})).status,403);
  assert.equal((await request(msgPath,{token:viewer.token})).body.messages[0].authorName,'member@example.test');
  const restricted=await createConversation(owner,'company',['member']);
  assert.equal((await request(`${companyBase}/conversations/${restricted.id}`,{token:admin.token})).status,404);
  assert.equal((await request(`${companyBase}/conversations/${restricted.id}`,{token:member.token})).status,200);
  // Insert history directly to test default latest-window retrieval without inflating request rates.
  for(let i=0;i<205;i++)await pool.query("INSERT INTO manager_messages(id,conversation_id,company_id,author_id,kind,content,created_at) VALUES($1,$2,$3,$4,'note',$5,now()+$6*interval '1 second')",[randomUUID(),shared.id,company,ownerId,`History ${i}`,i+1]);
  const history=(await request(msgPath,{token:member.token})).body;
  assert.equal(history.messages.length,200);assert.equal(history.messages.at(-1).content,'History 204');assert.equal(history.messages[0].content,'History 5');
  assert.equal((await request(`${msgPath}?after=${history.messages.at(-2).id}`,{token:member.token})).body.messages.length,1);
  assert.equal((await request(companyBase,{token:admin.token,method:'PATCH',data:{allowCompanySharing:false}})).status,403);
  assert.equal((await request(companyBase,{token:owner,method:'PATCH',data:{allowCompanySharing:false,defaultVisibility:'owner'}})).status,200);
  assert.equal((await request(msgPath,{token:member.token})).status,404);
  assert.equal((await request(`${companyBase}/conversations`,{token:member.token,method:'POST',data:{title:'Forbidden',visibility:'company'}})).status,403);
  const reinvite=await request(`${companyBase}/invites`,{token:owner,method:'POST',data:{email:'member@example.test',role:'member'}});
  assert.equal((await request(`${companyBase}/members/${member.user.id}`,{token:owner,method:'DELETE'})).status,200);
  assert.equal((await request('/api/auth/accept-invite',{method:'POST',data:{token:reinvite.body.token,name:'Revoked member',password}})).status,410);
  assert.equal((await request(`${companyBase}/conversations/${privateConversation.id}`,{token:member.token})).status,404);
  assert.equal((await request('/api/me',{token:member.token})).body.companies.length,0);
  // Cookie sessions require an exact Origin; the desktop bearer path does not need cookies.
  const browser=await request('/api/auth/login',{method:'POST',data:{email:'owner@example.test',password}});
  assert.equal(browser.status,200);assert.equal(browser.body.token,undefined);assert.match(browser.cookie,/HttpOnly/);
  const cookie=browser.cookie.split(';')[0];
  assert.equal((await request('/api/auth/logout',{method:'POST',data:{},headers:{Cookie:cookie}})).status,403);
  assert.equal((await request('/api/auth/logout',{method:'POST',data:{},headers:{Cookie:cookie,Origin:'https://evil.test'}})).status,403);
  assert.equal((await request('/api/auth/logout',{method:'POST',data:{},headers:{Cookie:cookie,Origin:origin}})).status,200);
  assert.equal((await request('/api/me',{headers:{Cookie:cookie}})).status,401);
  // Concurrent password changes cannot both validate the stale account hash.
  const changes=await Promise.all(['changed password one','changed password two'].map(next=>request('/api/auth/password',{token:viewer.token,method:'POST',data:{currentPassword:password,password:next}})));
  assert.deepEqual(changes.map(r=>r.status).sort(),[200,401]);
  assert.equal((await request('/api/me',{token:viewer.token})).status,401);
  const session=(await request('/api/auth/sessions',{token:owner})).body.sessions.find(s=>s.current);
  await request(`/api/auth/sessions/${session.id}`,{token:owner,method:'DELETE'});
  assert.equal((await request('/api/me',{token:owner})).status,401);
  const stored=(await pool.query('SELECT password_hash FROM manager_users LIMIT 1')).rows[0].password_hash;assert.match(stored,/^scrypt\$/);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM manager_sessions WHERE token_hash=$1',[owner])).rows[0].n,0);
  // Rate limiting is persisted in PostgreSQL and does not reset when a process restarts.
  for(let i=0;i<10;i++)await request('/api/auth/login',{method:'POST',data:{email:'nonexistent@example.test',password:'incorrect'}});
  assert.equal((await request('/api/auth/login',{method:'POST',data:{email:'nonexistent@example.test',password:'incorrect'}})).status,429);
});
