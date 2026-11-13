import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { migrate } from '../src/db.js';
import { createApp } from '../src/app.js';
const databaseUrl=process.env.MANAGER_TEST_DATABASE_URL;

// Comments and activity on shared notes: threads, replies, resolve, @mentions, the same product limits as the notes.
test('real PostgreSQL: note comments and activity follow the note’s own access',{skip:!databaseUrl},async t=>{
  const parsed=new URL(databaseUrl);
  assert.ok(['localhost','127.0.0.1','[::1]'].includes(parsed.hostname),'Only an isolated local test database is permitted.');
  assert.ok(parsed.pathname.startsWith('/terminai_test_'),'Test database must start terminai_test_.');
  const schema=`manager_test_${randomUUID().replaceAll('-','')}`;
  const control=new pg.Pool({connectionString:databaseUrl});await control.query(`CREATE SCHEMA ${schema}`);
  const pool=new pg.Pool({connectionString:databaseUrl,options:`-c search_path=${schema}`,max:10});
  let server;
  t.after(async()=>{if(server)await new Promise(r=>server.close(r));await pool.end();await control.query(`DROP SCHEMA ${schema} CASCADE`);await control.end();});
  await migrate(pool);await migrate(pool); // twice: the migration is safe to run again
  server=createServer(createApp(pool,{publicOrigin:'http://localhost:8080',trustProxyHops:0}));await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const origin=()=>`http://127.0.0.1:${server.address().port}`;
  async function request(path,{token,method='GET',data}={}){
    const response=await fetch(`${origin()}${path}`,{method,headers:{...(token?{Authorization:`Bearer ${token}`}:{}),...(data?{'Content-Type':'application/json'}:{})},body:data?JSON.stringify(data):undefined});
    return {status:response.status,body:await response.json()};
  }
  const password='long comments test password';
  const owner=(await request('/api/auth/signup',{method:'POST',data:{name:'Ada Lovelace',email:'ada@comments.test',companyName:'Alpha',password,client:'desktop'}})).body;
  const other=(await request('/api/auth/signup',{method:'POST',data:{name:'Zed',email:'zed@comments.test',companyName:'Zeta',password,client:'desktop'}})).body;
  const company=(await request('/api/me',{token:owner.token})).body.companies[0];
  const api=`/api/companies/${company.id}`;
  async function join(email,role,name){
    const inv=await request(`${api}/invites`,{token:owner.token,method:'POST',data:{email,role}});
    return (await request('/api/auth/accept-invite',{method:'POST',data:{token:inv.body.token,name,password,client:'desktop'}})).body;
  }
  const sofia=await join('sofia@comments.test','member','Sofia Rossi'),fritz=await join('fritz@comments.test','member','Fritz'),vi=await join('vi@comments.test','viewer','Vi');
  // Fritz works on mm.org only.
  assert.equal((await request(`${api}/members/${fritz.user.id}`,{token:owner.token,method:'PATCH',data:{products:['mm.org']}})).status,200);

  const make=async(title,product)=>(await request(`${api}/notes`,{token:owner.token,method:'POST',data:{kind:'doc',visibility:'company',title,body:'',product}})).body.note;
  const plan=await make('Launch plan','mm.org'), secret=await make('Pricing','ManyMotions');
  const comments=id=>`${api}/notes/${id}/comments`;

  // A comment, with an @mention, and a reply in its thread.
  const first=await request(comments(plan.id),{token:sofia.token,method:'POST',data:{body:'Can @fritz check the dates? cc @Ada'}});
  assert.equal(first.status,200);
  assert.equal(first.body.comment.authorName,'Sofia Rossi');assert.equal(first.body.comment.parentId,null);
  assert.deepEqual(first.body.comment.mentions.sort(),[fritz.user.id,owner.user.id].sort());
  const reply=await request(comments(plan.id),{token:fritz.token,method:'POST',data:{body:'Done, they hold.',parentId:first.body.comment.id}});
  assert.equal(reply.status,200);assert.equal(reply.body.comment.parentId,first.body.comment.id);
  // Replies stay one level deep; empty comments are refused.
  assert.equal((await request(comments(plan.id),{token:sofia.token,method:'POST',data:{body:'x',parentId:reply.body.comment.id}})).status,404);
  assert.equal((await request(comments(plan.id),{token:sofia.token,method:'POST',data:{body:'   '}})).status,400);
  let listed=(await request(comments(plan.id),{token:owner.token})).body;
  assert.deepEqual(listed.comments.map(c=>c.body),['Can @fritz check the dates? cc @Ada','Done, they hold.']);
  assert.equal(listed.canComment,true);

  // Viewers read the comments but do not write them.
  const viRead=await request(comments(plan.id),{token:vi.token});
  assert.equal(viRead.status,200);assert.equal(viRead.body.canComment,false);assert.equal(viRead.body.comments.length,2);
  assert.equal((await request(comments(plan.id),{token:vi.token,method:'POST',data:{body:'hi'}})).status,403);

  // Edit: the author or an admin; resolve: the author, the note's author or an admin, threads only.
  const firstUrl=`${comments(plan.id)}/${first.body.comment.id}`;
  assert.equal((await request(firstUrl,{token:fritz.token,method:'PATCH',data:{body:'hijack'}})).status,403);
  const edited=(await request(firstUrl,{token:sofia.token,method:'PATCH',data:{body:'Can @fritz check the dates?'}})).body.comment;
  assert.ok(edited.editedAt);assert.deepEqual(edited.mentions,[fritz.user.id]);
  assert.equal((await request(firstUrl,{token:fritz.token,method:'PATCH',data:{resolved:true}})).status,403);
  assert.equal((await request(`${comments(plan.id)}/${reply.body.comment.id}`,{token:fritz.token,method:'PATCH',data:{resolved:true}})).status,400);
  const resolved=(await request(firstUrl,{token:owner.token,method:'PATCH',data:{resolved:true}})).body.comment;
  assert.ok(resolved.resolvedAt);assert.equal(resolved.resolvedBy,owner.user.id);assert.equal(resolved.resolvedByName,'Ada Lovelace');
  const reopened=(await request(firstUrl,{token:sofia.token,method:'PATCH',data:{resolved:false}})).body.comment;
  assert.equal(reopened.resolvedAt,null);
  assert.equal((await request(firstUrl,{token:vi.token,method:'PATCH',data:{resolved:true}})).status,403);

  // Product limits: Fritz (mm.org only) never reaches the ManyMotions note's comments or activity, even with its id.
  const priced=(await request(comments(secret.id),{token:sofia.token,method:'POST',data:{body:'The new price is 9, right @Fritz?'}})).body.comment;
  assert.deepEqual(priced.mentions,[],'someone who cannot read the note is never @mentioned in it');
  assert.equal((await request(comments(secret.id),{token:fritz.token})).status,404);
  assert.equal((await request(comments(secret.id),{token:fritz.token,method:'POST',data:{body:'peek'}})).status,404);
  assert.equal((await request(`${api}/notes/${secret.id}/activity`,{token:fritz.token})).status,404);
  const fritzAll=(await request(`${api}/notes/activity`,{token:fritz.token})).body.activity;
  assert.ok(fritzAll.length&&fritzAll.every(a=>a.noteId===plan.id),'only his product’s notes');
  assert.ok((await request(`${api}/notes/activity`,{token:sofia.token})).body.activity.some(a=>a.noteId===secret.id));
  // Another workspace never reaches them either.
  assert.equal((await request(comments(plan.id),{token:other.token})).status,404);

  // Activity rows: autosave edits fold into one row; the product move, files and comments each have theirs.
  const note=`${api}/notes/${plan.id}`;
  await request(note,{token:sofia.token,method:'PATCH',data:{title:'Launch plan v2'}});
  await request(note,{token:sofia.token,method:'PATCH',data:{body:'Step one'}});
  await request(note,{token:sofia.token,method:'PATCH',data:{body:'Step one, two'}});
  await request(note,{token:owner.token,method:'PATCH',data:{product:'mm.org '}}); // same product once trimmed: no row
  const upload=(token,name)=>fetch(`${origin()}${note}/files?name=${name}&type=text/plain`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/octet-stream'},body:Buffer.from('hi')}).then(r=>r.json());
  const f1=(await upload(fritz.token,'a.txt')).file;await upload(fritz.token,'b.txt');
  await request(`${note}/files/${f1.id}`,{token:fritz.token,method:'DELETE'});
  const log=(await request(`${note}/activity`,{token:fritz.token})).body.activity;
  const actions=log.map(a=>`${a.byName}:${a.action}`);
  assert.deepEqual(actions,['Fritz:file_removed','Fritz:file_added','Sofia Rossi:edited','Sofia Rossi:reopened','Ada Lovelace:resolved','Fritz:commented','Sofia Rossi:commented','Ada Lovelace:created']);
  const edit=log.find(a=>a.action==='edited');assert.deepEqual(edit.detail.fields.sort(),['body','title']);assert.equal(edit.noteTitle,'Launch plan v2');
  const files=log.find(a=>a.action==='file_added');assert.equal(files.detail.count,2);assert.deepEqual(files.detail.names,['a.txt','b.txt']);
  assert.equal(log.find(a=>a.action==='file_removed').detail.names[0],'a.txt');
  assert.ok(!('notify' in log.find(a=>a.action==='commented').detail),'who is told stays on the server');
  // Who is told: the comment tagged Fritz (and the note's author); the reply tells the thread's author and the note's.
  const [replyRow,commentRow]=log.filter(a=>a.action==='commented');
  assert.equal(commentRow.forMe,true,'Fritz was @mentioned');
  assert.equal((await request(`${note}/activity`,{token:owner.token})).body.activity.filter(a=>a.action==='commented').every(a=>a.forMe),true,'the note’s author hears of both');
  assert.equal((await request(`${note}/activity`,{token:sofia.token})).body.activity.find(a=>a.id===replyRow.id).forMe,true,'a reply in her thread');
  assert.equal((await request(`${note}/activity`,{token:sofia.token})).body.activity.find(a=>a.id===commentRow.id).forMe,false,'never her own');
  await request(note,{token:owner.token,method:'PATCH',data:{product:'Other'}});
  const moved=(await request(`${api}/notes/activity?limit=1`,{token:owner.token})).body.activity[0];
  assert.equal(moved.action,'product');assert.deepEqual(moved.detail,{from:'mm.org',to:'Other'});
  // Moved out of his product, the note and all its history leave Fritz's view.
  assert.equal((await request(`${note}/activity`,{token:fritz.token})).status,404);
  assert.ok(!(await request(`${api}/notes/activity`,{token:fritz.token})).body.activity.length);
  // Paging: ?after returns only newer rows.
  const newest=(await request(`${api}/notes/activity`,{token:owner.token})).body.activity;
  assert.deepEqual((await request(`${api}/notes/activity?after=${newest[1].id}`,{token:owner.token})).body.activity.map(a=>a.id),[newest[0].id]);
  assert.equal((await request(`${api}/notes/activity?after=x`,{token:owner.token})).status,400);

  // Deleting: a comment by its author or an admin (with its replies); the note's deletion stays in the activity.
  assert.equal((await request(firstUrl,{token:fritz.token,method:'DELETE'})).status,404,'no longer his product');assert.equal((await request(firstUrl,{token:vi.token,method:'DELETE'})).status,403);
  assert.equal((await request(firstUrl,{token:owner.token,method:'DELETE'})).status,200);
  assert.equal((await request(comments(plan.id),{token:owner.token})).body.comments.length,0,'the reply went with its thread');
  assert.equal((await request(note,{token:owner.token,method:'DELETE'})).status,200);
  const after=(await request(`${api}/notes/activity`,{token:sofia.token})).body.activity[0];
  assert.equal(after.action,'deleted');assert.equal(after.noteTitle,'Launch plan v2');assert.equal(after.noteExists,false);
  assert.equal((await request(comments(plan.id),{token:owner.token})).status,404);

  // A private note: its comments and activity are its author's alone.
  const mine=(await request(`${api}/notes`,{token:sofia.token,method:'POST',data:{kind:'doc',title:'Diary'}})).body.note;
  assert.equal((await request(comments(mine.id),{token:sofia.token,method:'POST',data:{body:'note to self @Ada'}})).body.comment.mentions.length,0,'nobody else is told of a private note');
  assert.equal((await request(comments(mine.id),{token:owner.token})).status,404);
  assert.ok(!(await request(`${api}/notes/activity`,{token:owner.token})).body.activity.some(a=>a.noteId===mine.id));
});
