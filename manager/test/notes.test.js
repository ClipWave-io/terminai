import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { migrate } from '../src/db.js';
import { createApp } from '../src/app.js';
const databaseUrl=process.env.MANAGER_TEST_DATABASE_URL;
test('real PostgreSQL: open sign-up, private notes stay private, the team board and its permissions',{skip:!databaseUrl},async t=>{
  const parsed=new URL(databaseUrl);
  assert.ok(['localhost','127.0.0.1','[::1]'].includes(parsed.hostname),'Only an isolated local test database is permitted.');
  assert.ok(parsed.pathname.startsWith('/terminai_test_'),'Test database must start terminai_test_.');
  const schema=`manager_test_${randomUUID().replaceAll('-','')}`;
  const control=new pg.Pool({connectionString:databaseUrl});await control.query(`CREATE SCHEMA ${schema}`);
  const pool=new pg.Pool({connectionString:databaseUrl,options:`-c search_path=${schema}`,max:10});
  let server,closed;
  t.after(async()=>{for(const s of [server,closed])if(s)await new Promise(r=>s.close(r));await pool.end();await control.query(`DROP SCHEMA ${schema} CASCADE`);await control.end();});
  await migrate(pool);
  server=createServer(createApp(pool,{publicOrigin:'http://localhost:8080',trustProxyHops:0}));await new Promise(r=>server.listen(0,'127.0.0.1',r));
  async function request(path,{token,method='GET',data,at=server}={}){
    const response=await fetch(`http://127.0.0.1:${at.address().port}${path}`,{method,headers:{...(token?{Authorization:`Bearer ${token}`}:{}),...(data?{'Content-Type':'application/json'}:{})},body:data?JSON.stringify(data):undefined});
    return {status:response.status,body:await response.json()};
  }
  const password='long notes test password';
  // No setup token: the first and any later team sign up on their own and never see each other.
  assert.equal((await request('/api/setup')).body.signupOpen,true);
  const a=await request('/api/auth/signup',{method:'POST',data:{name:'Ada',email:'ada@example.test',companyName:'Alpha',password,client:'desktop'}});
  assert.equal(a.status,200);
  const b=await request('/api/auth/signup',{method:'POST',data:{name:'Bo',email:'bo@example.test',companyName:'Beta',password,client:'desktop'}});
  assert.equal(b.status,200);
  assert.equal((await request('/api/auth/signup',{method:'POST',data:{name:'Again',email:'ADA@example.test',companyName:'Dup',password}})).status,409);
  // Solo use: no workspace name needed, one is made for you.
  const solo=await request('/api/auth/signup',{method:'POST',data:{name:'Sol Lee',email:'sol@example.test',password,client:'desktop'}});
  assert.equal(solo.status,200);
  const soloMe=(await request('/api/me',{token:solo.body.token})).body.companies;
  assert.equal(soloMe.length,1);assert.equal(soloMe[0].name,'Sol’s workspace');assert.equal(soloMe[0].role,'owner');
  const alpha=(await request('/api/me',{token:a.body.token})).body.companies[0],beta=(await request('/api/me',{token:b.body.token})).body.companies[0];
  assert.equal(alpha.role,'owner');assert.notEqual(alpha.id,beta.id);
  const notes=`/api/companies/${alpha.id}/notes`;
  assert.equal((await request(notes,{token:b.body.token})).status,404);

  // A teammate joins Alpha by invitation, and a viewer too.
  async function join(email,role){
    const inv=await request(`/api/companies/${alpha.id}/invites`,{token:a.body.token,method:'POST',data:{email,role}});
    return (await request('/api/auth/accept-invite',{method:'POST',data:{token:inv.body.token,name:email.split('@')[0],password,client:'desktop'}})).body;
  }
  const cy=await join('cy@example.test','member'),vi=await join('vi@example.test','viewer');

  const mine=(await request(notes,{token:a.body.token,method:'POST',data:{title:'My own idea',body:'only me'}})).body.note;
  assert.equal(mine.visibility,'private');
  const shared=(await request(notes,{token:a.body.token,method:'POST',data:{title:'Ship it',visibility:'company',assigneeId:cy.user.id}})).body.note;
  assert.equal(shared.assigneeId,cy.user.id);
  // Private stays private even from the owner's teammates; the board is everyone's.
  const cyNotes=(await request(notes,{token:cy.token})).body.notes;
  assert.deepEqual(cyNotes.map(n=>n.title),['Ship it']);
  assert.equal((await request(`${notes}/${mine.id}`,{token:cy.token,method:'PATCH',data:{title:'x'}})).status,404);
  // A teammate ticks the shared one off; the board says who did it.
  const done=(await request(`${notes}/${shared.id}`,{token:cy.token,method:'PATCH',data:{status:'done'}})).body.note;
  assert.equal(done.status,'done');assert.equal(done.updatedBy,cy.user.id);
  // Only the author moves a note between private and team; only the author or an admin deletes it.
  assert.equal((await request(`${notes}/${shared.id}`,{token:cy.token,method:'PATCH',data:{visibility:'private'}})).status,403);
  assert.equal((await request(`${notes}/${shared.id}`,{token:cy.token,method:'DELETE'})).status,403);
  // Assignees must be in the team; viewers read the board but don't write to it.
  assert.equal((await request(notes,{token:a.body.token,method:'POST',data:{title:'x',visibility:'company',assigneeId:b.body.user.id}})).status,400);
  assert.equal((await request(notes,{token:vi.token,method:'POST',data:{title:'x',visibility:'company'}})).status,403);
  assert.equal((await request(notes,{token:vi.token})).body.notes.length,1);
  assert.equal((await request(notes,{token:vi.token,method:'POST',data:{title:'viewer private'}})).status,200);
  // Sharing a private note puts it on the board; moving it back takes it off.
  await request(`${notes}/${mine.id}`,{token:a.body.token,method:'PATCH',data:{visibility:'company',position:0.5}});
  assert.deepEqual((await request(notes,{token:cy.token})).body.notes.map(n=>n.title),['My own idea','Ship it']);
  assert.equal((await request(`${notes}/${shared.id}`,{token:a.body.token,method:'DELETE'})).status,200);

  // Shared notes, like Apple Notes: a document with files in it, which the teammate reads and adds to.
  const doc=(await request(notes,{token:a.body.token,method:'POST',data:{kind:'doc',visibility:'company',title:'Launch plan',body:'Line one\nLine two'}})).body.note;
  assert.equal(doc.kind,'doc');assert.deepEqual(doc.files,[]);
  const upload=async(token,name,bytes,type='text/plain')=>{const r=await fetch(`http://127.0.0.1:${server.address().port}${notes}/${doc.id}/files?name=${encodeURIComponent(name)}&type=${encodeURIComponent(type)}`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/octet-stream'},body:bytes});return {status:r.status,body:await r.json()};};
  const added=await upload(cy.token,'plan.txt',Buffer.from('hello file'));
  assert.equal(added.status,200);assert.equal(added.body.file.size,10);assert.equal(added.body.file.mime,'text/plain');
  assert.equal((await upload(vi.token,'nope.txt',Buffer.from('x'))).status,403);
  assert.equal((await upload(cy.token,'big.bin',Buffer.alloc(25*1024*1024+1))).status,413);
  const listed=(await request(notes,{token:a.body.token})).body.notes.find(n=>n.id===doc.id);
  assert.deepEqual(listed.files.map(f=>f.name),['plan.txt']);assert.equal(listed.updatedBy,cy.user.id);
  const got=await fetch(`http://127.0.0.1:${server.address().port}${notes}/${doc.id}/files/${added.body.file.id}`,{headers:{Authorization:`Bearer ${vi.token}`}});
  assert.equal(got.headers.get('content-type'),'application/octet-stream');assert.match(got.headers.get('content-disposition'),/attachment/);
  assert.equal(await got.text(),'hello file');
  // Another workspace never reaches it, even with the ids.
  assert.equal((await fetch(`http://127.0.0.1:${server.address().port}${notes}/${doc.id}/files/${added.body.file.id}`,{headers:{Authorization:`Bearer ${b.body.token}`}})).status,404);
  assert.equal((await request(`${notes}/${doc.id}/files/${added.body.file.id}`,{token:a.body.token,method:'DELETE'})).status,200);
  assert.deepEqual((await request(notes,{token:cy.token})).body.notes.find(n=>n.id===doc.id).files,[]);

  // An operator can close sign-up; then it is invitation only.
  closed=createServer(createApp(pool,{publicOrigin:'http://localhost:8080',trustProxyHops:0,signupOpen:false}));await new Promise(r=>closed.listen(0,'127.0.0.1',r));
  assert.equal((await request('/api/setup',{at:closed})).body.signupOpen,false);
  assert.equal((await request('/api/auth/signup',{at:closed,method:'POST',data:{name:'Z',email:'z@example.test',companyName:'Z',password}})).status,403);
});
