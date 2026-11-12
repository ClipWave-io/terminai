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

  // Sign in with the browser: the app gets a code, a signed-in person allows it, the app collects a desktop session once.
  const started=(await request('/api/auth/device/start',{method:'POST',data:{}})).body;
  assert.match(started.code,/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);assert.equal(started.verifyUrl,`http://localhost:8080/#device=${started.code}`);
  assert.deepEqual((await request('/api/auth/device/poll',{method:'POST',data:{pollToken:started.pollToken}})).body,{pending:true});
  assert.equal((await request('/api/auth/device/approve',{method:'POST',data:{code:started.code}})).status,401,'only a signed-in person allows it');
  assert.equal((await request('/api/auth/device/approve',{token:cy.token,method:'POST',data:{code:'AAAA-AAAA'}})).status,404);
  assert.equal((await request('/api/auth/device/approve',{token:cy.token,method:'POST',data:{code:started.code.toLowerCase()}})).status,200);
  assert.equal((await request('/api/auth/device/approve',{token:a.body.token,method:'POST',data:{code:started.code}})).status,404,'a code is allowed once');
  const collected=(await request('/api/auth/device/poll',{method:'POST',data:{pollToken:started.pollToken}})).body;
  assert.equal(collected.user.email,'cy@example.test');assert.match(collected.token,/^[A-Za-z0-9_-]{43}$/);
  assert.equal((await request('/api/me',{token:collected.token})).body.user.email,'cy@example.test');
  assert.equal((await request('/api/auth/device/poll',{method:'POST',data:{pollToken:started.pollToken}})).status,410,'collected once');

  // Joining without a password: the invitation link signs in; a first password can be set later without a current one.
  const inv=(await request(`/api/companies/${alpha.id}/invites`,{token:a.body.token,method:'POST',data:{email:'mo@example.test',role:'member'}})).body;
  const mo=await request('/api/auth/accept-invite',{method:'POST',data:{token:inv.token,name:'Mo',client:'desktop'}});
  assert.equal(mo.status,200);assert.match(mo.body.token,/^[A-Za-z0-9_-]{43}$/);
  assert.equal((await request('/api/auth/login',{method:'POST',data:{email:'mo@example.test',password:''}})).status,401,'no password, no password sign-in');
  assert.equal((await request('/api/me',{token:mo.body.token,method:'PATCH',data:{name:'Mo Rossi'}})).body.user.name,'Mo Rossi');
  assert.equal((await request('/api/auth/password',{token:mo.body.token,method:'POST',data:{password:'a brand new password'}})).status,200);
  const moAgain=await request('/api/auth/login',{method:'POST',data:{email:'mo@example.test',password:'a brand new password',client:'desktop'}});assert.equal(moAgain.status,200);mo.body.token=moAgain.body.token;

  // The To-do's shared page: Macs copy their tasks in keeping the time they changed; the phone's edits are stamped now.
  const tasks=`/api/companies/${alpha.id}/tasks`;
  assert.equal((await request(tasks,{token:b.body.token})).status,404);
  assert.equal((await request(`${tasks}/people`,{token:a.body.token,method:'PUT',data:{key:'ilai'}})).status,200);
  const task={id:'t1',title:'Ship it',notes:'',status:'open',assignee:'both',product:'',createdAt:'2026-10-20T10:00:00.000+02:00',createdBy:'ilai',updatedAt:'2026-10-20T10:00:00.000+02:00',updatedBy:'ilai'};
  assert.equal((await request(`${tasks}/t1`,{token:a.body.token,method:'PUT',data:{task}})).body.task.updatedAt,task.updatedAt);
  assert.equal((await request(`${tasks}/t1`,{token:a.body.token,method:'PUT',data:{task:{...task,status:'maybe'}}})).status,400);
  assert.equal((await request(`${tasks}/t2`,{token:a.body.token,method:'PUT',data:{task}})).status,400,'id must match');
  let all=(await request(tasks,{token:a.body.token})).body;
  assert.equal(all.tasks.length,1);assert.equal(all.me,'ilai');assert.equal(all.people.ilai.name,'Ada');
  const phone=(await request(`${tasks}/t1`,{token:a.body.token,method:'PUT',data:{task:{...task,status:'done',updatedAt:undefined,updatedVia:'iphone'}}})).body.task;
  assert.ok(Date.parse(phone.updatedAt)>Date.parse(task.updatedAt));
  assert.equal((await request(`${tasks}/t1`,{token:a.body.token,method:'DELETE'})).status,200);
  all=(await request(tasks,{token:a.body.token})).body;
  assert.equal(all.tasks.length,0);assert.equal(all.deleted[0].id,'t1');
  assert.equal((await request(`${tasks}/t1`,{token:a.body.token,method:'PUT',data:{task}})).status,200,'a Mac can bring it back');
  assert.equal((await request(tasks,{token:a.body.token})).body.tasks.length,1);

  // The work log: written into one's own column, read by the workspace.
  const day={day:'2026-11-04',workingMinutes:90,projects:[],conversations:[],writtenAt:new Date().toISOString()};
  assert.equal((await request(`/api/companies/${alpha.id}/worklog/2026-11-04`,{token:a.body.token,method:'PUT',data:{data:day}})).status,200);
  const logged=(await request(`/api/companies/${alpha.id}/worklog/2026-11-04`,{token:a.body.token})).body;
  assert.equal(logged.people.ilai.workingMinutes,90);
  assert.deepEqual((await request(`/api/companies/${alpha.id}/worklog`,{token:a.body.token})).body.days,[{day:'2026-11-04',people:['ilai']}]);
  assert.equal((await request(`/api/companies/${alpha.id}/worklog/2026-11-04`,{token:b.body.token})).status,404);

  // Tabs as conversations, and agent messages between them: Ada's tab shared, Mo (a member) messages it, Ada's Mac takes it and answers.
  const tabA=(await request(`/api/companies/${alpha.id}/conversations/tab/key-a`,{token:a.body.token,method:'PUT',data:{title:'Fix login',place:'~/app',status:'working'}})).body.conversation;
  assert.equal(tabA.tab,true);assert.equal(tabA.live,true);assert.equal(tabA.visibility,'company');
  assert.equal((await request(`/api/companies/${alpha.id}/conversations/tab/key-a`,{token:a.body.token,method:'PUT',data:{title:'Fix login 2'}})).body.conversation.id,tabA.id,'same tab, same conversation');
  const tabMo=(await request(`/api/companies/${alpha.id}/conversations/tab/key-m`,{token:mo.body.token,method:'PUT',data:{title:'Mo tab'}})).body.conversation;
  await request(`/api/companies/${alpha.id}`,{token:a.body.token,method:'PATCH',data:{sessionVisibility:'all'}});
  const shownRes=await request(`/api/companies/${alpha.id}/conversations`,{token:mo.body.token});assert.equal(shownRes.status,200,JSON.stringify(shownRes.body));const shown=shownRes.body.conversations;
  assert.ok(shown.some(c=>c.id===tabA.id&&c.ownerName==='Ada'));
  const sent=(await request(`/api/companies/${alpha.id}/agent`,{token:mo.body.token,method:'POST',data:{to:tabA.id,from:tabMo.id,content:'Which branch has the fix?'}})).body;
  assert.equal(sent.live,true);
  assert.equal((await request(`/api/companies/${alpha.id}/agent`,{token:b.body.token,method:'POST',data:{to:tabA.id,content:'x'}})).status,404,'another workspace cannot');
  const inbox=(await request(`/api/companies/${alpha.id}/agent/inbox`,{token:a.body.token})).body.messages;
  assert.equal(inbox.length,1);assert.equal(inbox[0].tab,'key-a');assert.equal(inbox[0].fromName,'Mo Rossi');
  assert.equal((await request(`/api/companies/${alpha.id}/agent/inbox`,{token:mo.body.token})).body.messages.length,0);
  assert.equal((await request(`/api/companies/${alpha.id}/agent/${sent.id}/delivered`,{token:a.body.token,method:'POST',data:{}})).status,200);
  // The recipient can always find who sent it (a reply after a restart); the sender cannot ask.
  assert.equal((await request(`/api/companies/${alpha.id}/agent/${sent.id}/from`,{token:a.body.token})).body.from,tabMo.id);
  assert.equal((await request(`/api/companies/${alpha.id}/agent/${sent.id}/from`,{token:mo.body.token})).status,403);
  // And the reply goes through, bound to the session that asked.
  assert.equal((await request(`/api/companies/${alpha.id}/agent`,{token:a.body.token,method:'POST',data:{to:tabMo.id,from:tabA.id,replyTo:sent.id,content:'main'}})).status,200,'reply to the asking session');
  assert.equal((await request(`/api/companies/${alpha.id}/agent`,{token:a.body.token,method:'POST',data:{to:tabA.id,replyTo:sent.id,content:'forged'}})).status,404,'a reply elsewhere is refused');
  assert.equal((await request(`/api/companies/${alpha.id}/agent/inbox`,{token:a.body.token})).body.messages.length,0);
  assert.equal((await request(`/api/companies/${alpha.id}/agent`,{token:a.body.token,method:'POST',data:{to:tabMo.id,from:tabA.id,replyTo:sent.id,content:'main'}})).status,200);
  const replies=(await request(`/api/companies/${alpha.id}/agent/${sent.id}/replies`,{token:mo.body.token})).body;
  assert.equal(replies.delivered,true);assert.equal(replies.replies[0].content,'main');
  // A tab made private: nobody else reads or messages it.
  await request(`/api/companies/${alpha.id}/conversations/tab/key-a`,{token:a.body.token,method:'PUT',data:{title:'Fix login',visibility:'owner'}});
  assert.equal((await request(`/api/companies/${alpha.id}/agent`,{token:mo.body.token,method:'POST',data:{to:tabA.id,content:'still?'}})).status,404);

  // An invitation link: anyone with it joins for 24 hours with their own name and email; never into an existing passwordless account.
  const link=(await request(`/api/companies/${alpha.id}/invites/link`,{token:mo.body.token,method:'POST',data:{}})).body;
  assert.equal(link.expiresInHours,24);assert.equal(link.role,'member');
  assert.equal((await request(`/api/companies/${alpha.id}/invites/link`,{token:mo.body.token,method:'POST',data:{role:'admin'}})).status,403,'only the owner gives admin');
  const p1=await request('/api/auth/accept-invite',{method:'POST',data:{token:link.token,name:'Pia',email:'pia@example.test',client:'desktop'}});
  assert.equal(p1.status,200);
  assert.equal((await request('/api/auth/accept-invite',{method:'POST',data:{token:link.token,name:'Quin',email:'quin@example.test',client:'desktop'}})).status,200,'the same link works again');
  assert.equal((await request('/api/auth/accept-invite',{method:'POST',data:{token:link.token,name:'x',email:'pia@example.test',client:'desktop'}})).status,401,'not into an account that exists');
  assert.ok((await request('/api/me',{token:p1.body.token})).body.companies.some(c=>c.id===alpha.id));
  await pool.query("UPDATE manager_invite_links SET expires_at=now()-interval '1 minute'");
  assert.equal((await request('/api/auth/accept-invite',{method:'POST',data:{token:link.token,name:'Late',email:'late@example.test',client:'desktop'}})).status,410);

  // Open TerminAI from the website: a one-time code the app trades for a desktop session.
  const hand=(await request('/api/auth/handoff',{token:a.body.token,method:'POST',data:{}})).body.url;
  const code=new URL(hand).searchParams.get('code');assert.match(hand,/^terminai:\/\/signin\?code=/);
  const traded=(await request('/api/auth/device/poll',{method:'POST',data:{pollToken:code}})).body;
  assert.equal(traded.user.email,'ada@example.test');
  assert.equal((await request('/api/auth/device/poll',{method:'POST',data:{pollToken:code}})).status,410,'once');
  assert.equal((await request('/api/auth/handoff',{method:'POST',data:{}})).status,401);

  // Deleting what was uploaded: one conversation by its owner only, then everything of one's own.
  assert.equal((await request(`/api/companies/${alpha.id}/conversations/${tabMo.id}`,{token:a.body.token,method:'DELETE'})).status,403);
  assert.equal((await request(`/api/companies/${alpha.id}/conversations/${tabMo.id}`,{token:mo.body.token,method:'DELETE'})).status,200);
  assert.equal((await request(`/api/companies/${alpha.id}/conversations/${tabMo.id}/messages`,{token:mo.body.token})).status,404);
  const wiped=(await request(`/api/companies/${alpha.id}/uploads`,{token:a.body.token,method:'DELETE'})).body;
  assert.ok(wiped.sessions>=1&&wiped.days>=1);
  assert.deepEqual((await request(`/api/companies/${alpha.id}/worklog`,{token:a.body.token})).body.days,[]);

  // Bot keys: act for their maker on shared sessions; list, read, message; nothing else.
  const tabB=(await request(`/api/companies/${alpha.id}/conversations/tab/key-b`,{token:a.body.token,method:'PUT',data:{title:'Shared tab',visibility:'company'}})).body.conversation;
  const tabP=(await request(`/api/companies/${alpha.id}/conversations/tab/key-p`,{token:a.body.token,method:'PUT',data:{title:'Mine',visibility:'owner'}})).body.conversation;
  const bot=(await request(`/api/companies/${alpha.id}/bots`,{token:a.body.token,method:'POST',data:{name:'Grokbot'}})).body;
  assert.match(bot.key,/^tbot_/);
  const asBot=(path,o={})=>fetch(`http://127.0.0.1:${server.address().port}${path}`,{method:o.method||'GET',headers:{Authorization:`Bearer ${bot.key}`,...(o.data?{'Content-Type':'application/json'}:{})},body:o.data?JSON.stringify(o.data):undefined}).then(async r=>({status:r.status,body:await r.json()}));
  const seen=(await asBot(`/api/companies/${alpha.id}/conversations`)).body.conversations.map(c=>c.id);
  assert.ok(seen.includes(tabB.id));assert.ok(!seen.includes(tabP.id),'not the private one');
  assert.equal((await asBot(`/api/companies/${alpha.id}/notes`)).status,403,'nothing else');
  assert.equal((await asBot('/api/auth/password',{method:'POST',data:{password:'xxxxxxxxxxxxxxxx'}})).status,403);
  // A bot key never becomes its maker's account: no sign-in hand-off, device approval, account or sessions.
  for(const [path,method] of [['/api/auth/handoff','POST'],['/api/auth/device/approve','POST'],['/api/me','GET'],['/api/auth/sessions','GET'],['/api/companies','POST']])
    assert.equal((await asBot(path,{method,data:method==='POST'?{}:undefined})).status,403,`bot key on ${method} ${path}`);
  const t0=Date.now();const waited=request(`/api/companies/${alpha.id}/agent/inbox?wait=5`,{token:a.body.token});
  await new Promise(r=>setTimeout(r,800));
  assert.equal((await asBot(`/api/companies/${alpha.id}/agent`,{method:'POST',data:{to:tabB.id,content:'hello from grok'}})).status,200);
  const fromBot=(await waited).body.messages.find(m=>m.content==='hello from grok');
  assert.ok(fromBot&&fromBot.bot&&/Grokbot/.test(fromBot.fromName)&&!fromBot.self);assert.ok(Date.now()-t0<4000,'the long poll answers at once');
  // It may answer into its maker's own private tab (the id comes with an ask-grok question), never read it.
  assert.equal((await asBot(`/api/companies/${alpha.id}/agent`,{method:'POST',data:{to:tabP.id,content:'general: pong'}})).status,200);
  assert.equal((await asBot(`/api/companies/${alpha.id}/conversations/${tabP.id}/messages`)).status,404);
  // Limits: read-only cannot message; reply-only answers only where it was asked (30 min); a list of conversations narrows all.
  const B=`/api/companies/${alpha.id}/bots/${bot.id}`;
  assert.equal((await request(B,{token:a.body.token,method:'PATCH',data:{scope:'read'}})).status,200);
  assert.equal((await asBot(`/api/companies/${alpha.id}/agent`,{method:'POST',data:{to:tabB.id,content:'x'}})).status,403,'read-only');
  assert.equal((await request(B,{token:a.body.token,method:'PATCH',data:{scope:'reply',approval:'every'}})).status,200);
  assert.equal((await asBot(`/api/companies/${alpha.id}/agent`,{method:'POST',data:{to:tabB.id,content:'x'}})).status,403,'not asked');
  assert.equal((await request(`${B}/asked`,{token:a.body.token,method:'POST',data:{conversation:tabB.id}})).status,200);
  assert.equal((await asBot(`/api/companies/${alpha.id}/agent`,{method:'POST',data:{to:tabB.id,content:'general: the answer'}})).status,200,'asked, so it may answer');
  const fromLimited=(await request(`/api/companies/${alpha.id}/agent/inbox`,{token:a.body.token})).body.messages.find(m=>m.content==='general: the answer');
  assert.equal(fromLimited.botApproval,'every');assert.equal(fromLimited.botScope,'reply');
  const tabC=(await request(`/api/companies/${alpha.id}/conversations/tab/key-c`,{token:a.body.token,method:'PUT',data:{title:'Other shared',visibility:'company'}})).body.conversation;
  assert.equal((await request(B,{token:a.body.token,method:'PATCH',data:{conversations:[tabB.id],scope:'full'}})).status,200);
  const narrowed=(await asBot(`/api/companies/${alpha.id}/conversations`)).body.conversations.map(c=>c.id);
  assert.ok(narrowed.includes(tabB.id)&&!narrowed.includes(tabC.id),'only its conversations');
  assert.equal((await asBot(`/api/companies/${alpha.id}/conversations/${tabC.id}/messages`)).status,404);
  assert.equal((await asBot(`/api/companies/${alpha.id}/conversations/${tabB.id}/messages`)).status,200);
  const act=(await request(`${B}/activity`,{token:a.body.token})).body.activity.map(x=>x.action);
  assert.ok(act.includes('list')&&act.includes('message')&&act.includes('read'),'activity logged');
  assert.equal((await request(B,{token:a.body.token,method:'PATCH',data:{days:0}})).status,200);
  await request(`/api/companies/${alpha.id}/bots/${bot.id}`,{token:a.body.token,method:'DELETE'});
  assert.equal((await asBot(`/api/companies/${alpha.id}/conversations`)).status,401,'revoked');
  // A password set from the app keeps its devices signed in.
  assert.equal((await request('/api/auth/password',{token:a.body.token,method:'POST',data:{password:'set from the app 12'}})).status,200);
  assert.equal((await request('/api/me',{token:a.body.token})).status,200);

  // Permissions: a member limited to one product sees only its tasks and notes; others' sessions only when the workspace allows.
  const pia=(await request(`/api/companies/${alpha.id}/members`,{token:a.body.token})).body.members.find(m=>m.email==='pia@example.test');
  assert.equal((await request(`/api/companies/${alpha.id}/members/${pia.id}`,{token:a.body.token,method:'PATCH',data:{products:['mm.org']}})).status,200);
  await request(`/api/companies/${alpha.id}/tasks/t9`,{token:a.body.token,method:'PUT',data:{task:{...task,id:'t9',product:'mm.org'}}});
  await request(`/api/companies/${alpha.id}/tasks/t8`,{token:a.body.token,method:'PUT',data:{task:{...task,id:'t8',product:'ManyMotions'}}});
  const piaTasks=(await request(`/api/companies/${alpha.id}/tasks`,{token:p1.body.token})).body.tasks.map(t=>t.id);
  assert.ok(piaTasks.includes('t9')&&!piaTasks.includes('t8'),'only her product');
  assert.equal((await request(`/api/companies/${alpha.id}/tasks/t7`,{token:p1.body.token,method:'PUT',data:{task:{...task,id:'t7',product:'ManyMotions'}}})).status,403);
  const tabX=(await request(`/api/companies/${alpha.id}/conversations/tab/key-x`,{token:a.body.token,method:'PUT',data:{title:'Owner tab',visibility:'company'}})).body.conversation;
  await request(`/api/companies/${alpha.id}`,{token:a.body.token,method:'PATCH',data:{sessionVisibility:'admins'}});
  assert.ok(!(await request(`/api/companies/${alpha.id}/conversations`,{token:p1.body.token})).body.conversations.some(c=>c.id===tabX.id),'admins only');
  await request(`/api/companies/${alpha.id}`,{token:a.body.token,method:'PATCH',data:{sessionVisibility:'all'}});
  assert.ok((await request(`/api/companies/${alpha.id}/conversations`,{token:p1.body.token})).body.conversations.some(c=>c.id===tabX.id));

  // Team files: per-file access; chat with presence, typing, read receipts and a long poll.
  const base=`http://127.0.0.1:${server.address().port}/api/companies/${alpha.id}`;
  const put=async(token,name,q='')=>{const r=await fetch(`${base}/files?name=${name}&type=text/plain${q}`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/octet-stream'},body:Buffer.from('hi '+name)});return {status:r.status,body:await r.json()}};
  const fAll=(await put(a.body.token,'all.txt')).body.file, fAdm=(await put(a.body.token,'adm.txt','&access=admins')).body.file;
  const fMm=(await put(a.body.token,'mm.txt','&access=products&products=mm.org')).body.file, fMany=(await put(a.body.token,'many.txt','&access=products&products=ManyMotions')).body.file;
  const piaFiles=(await request(`/api/companies/${alpha.id}/files`,{token:p1.body.token})).body.files.map(f=>f.id);
  assert.deepEqual([fAll.id,fMm.id].every(id=>piaFiles.includes(id)),true); assert.ok(!piaFiles.includes(fAdm.id)&&!piaFiles.includes(fMany.id),'per-file access');
  assert.equal((await fetch(`${base}/files/${fAdm.id}`,{headers:{Authorization:`Bearer ${p1.body.token}`}})).status,404);
  assert.equal(await (await fetch(`${base}/files/${fMm.id}`,{headers:{Authorization:`Bearer ${p1.body.token}`}})).text(),'hi mm.txt');
  assert.equal((await request(`/api/companies/${alpha.id}/files/${fAll.id}`,{token:p1.body.token,method:'DELETE'})).status,403,'not hers');
  assert.equal((await request(`/api/companies/${alpha.id}/files/${fMany.id}`,{token:a.body.token,method:'PATCH',data:{access:'all'}})).status,200);
  assert.ok((await request(`/api/companies/${alpha.id}/files`,{token:p1.body.token})).body.files.some(f=>f.id===fMany.id));
  // Read before ever opening the chat still counts.
  await request(`/api/companies/${alpha.id}/chat`,{token:a.body.token,method:'POST',data:{body:'first'}});
  await request(`/api/companies/${alpha.id}/chat/read`,{token:mo.body.token,method:'POST',data:{}});
  assert.ok((await request(`/api/companies/${alpha.id}/chat`,{token:a.body.token})).body.people.find(x=>x.name.startsWith('Mo'))?.readAt,'read receipt without an earlier visit');
  await request(`/api/companies/${alpha.id}/chat/typing`,{token:a.body.token,method:'POST',data:{}});
  // Pia is limited to products: she has their chats, not the team one.
  assert.equal((await request(`/api/companies/${alpha.id}/chat`,{token:p1.body.token})).status,403);
  const c0=(await request(`/api/companies/${alpha.id}/chat?channel=mm.org`,{token:p1.body.token})).body;
  assert.ok(c0.people.find(x=>x.id===c0.people.find(y=>y.name==='Ada')?.id)?.typing,'Ada is typing');
  const waiting=request(`/api/companies/${alpha.id}/chat?channel=mm.org&after=${encodeURIComponent(new Date().toISOString())}&wait=10&typing=${encodeURIComponent(c0.people.filter(x=>x.typing).map(x=>x.id).join(','))}`,{token:p1.body.token});
  await new Promise(r=>setTimeout(r,700));
  assert.equal((await request(`/api/companies/${alpha.id}/chat`,{token:a.body.token,method:'POST',data:{body:'Review the NDA asap please',channel:'mm.org'}})).status,200);
  await request(`/api/companies/${alpha.id}/chat`,{token:a.body.token,method:'POST',data:{body:'',fileId:fAdm.id,channel:'mm.org'}});
  const woke=(await waiting).body; assert.ok(woke.messages.some(m=>m.body==='Review the NDA asap please'),'long poll wakes up');
  const chatAll=(await request(`/api/companies/${alpha.id}/chat?channel=mm.org`,{token:p1.body.token})).body.messages;
  assert.ok(chatAll.find(m=>m.file)?.file.hidden,'a file she may not see stays hidden in the chat');
  await request(`/api/companies/${alpha.id}/chat/read`,{token:p1.body.token,method:'POST',data:{}});
  const seenBy=(await request(`/api/companies/${alpha.id}/chat`,{token:a.body.token})).body.people.find(x=>x.name!=='Ada'&&x.readAt);
  assert.ok(seenBy&&seenBy.online,'read receipt and online');

  // An operator can close sign-up; then it is invitation only.
  closed=createServer(createApp(pool,{publicOrigin:'http://localhost:8080',trustProxyHops:0,signupOpen:false}));await new Promise(r=>closed.listen(0,'127.0.0.1',r));
  assert.equal((await request('/api/setup',{at:closed})).body.signupOpen,false);
  assert.equal((await request('/api/auth/signup',{at:closed,method:'POST',data:{name:'Z',email:'z@example.test',companyName:'Z',password}})).status,403);
});
