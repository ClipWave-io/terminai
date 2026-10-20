// The To-do store against a real bare git repo: personal file, shared clone, push retry and both conflict directions.
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{execFileSync}=require('node:child_process');
const {buildSync}=require('esbuild');
const bundled=buildSync({entryPoints:[path.join(__dirname,'../src/main/todos.ts')],bundle:true,platform:'node',format:'cjs',write:false}).outputFiles[0].text;
const loaded=new module.constructor();loaded._compile(bundled,path.join(__dirname,'todos.bundle.cjs'));
const {createTodos,romeIso}=loaded.exports;
const git=(cwd,...args)=>execFileSync('git',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe'],env:{...process.env,GIT_TERMINAL_PROMPT:'0'}});
const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
function setup(){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'terminai-todos-test-')),bare=path.join(root,'tasks.git'),seed=path.join(root,'seed'),ilai=path.join(root,'ilai');
 git(root,'init','-q','--bare','-b','main',bare);git(root,'clone','-q',bare,seed);
 fs.mkdirSync(path.join(seed,'tasks'));fs.writeFileSync(path.join(seed,'README.md'),'# tasks\n');fs.writeFileSync(path.join(seed,'tasks/.gitkeep'),'');
 git(seed,'add','-A');git(seed,'commit','-q','-m','seed');git(seed,'push','-q','origin','HEAD:main');git(root,'clone','-q',bare,ilai);
 const app=(name,user=name)=>{const dir=path.join(root,name+'-app');fs.mkdirSync(dir,{recursive:true});return createTodos(dir,{remote:'file://'+bare,user:()=>user,changed:()=>{}})};
 // Ilai's Mac, edited by hand: the file as TerminAI would write it, then commit and push.
 const push=(task,message)=>{git(ilai,'pull','-q','--rebase');fs.writeFileSync(path.join(ilai,'tasks',task.id+'.json'),JSON.stringify(task,null,2)+'\n');git(ilai,'add','-A');git(ilai,'commit','-q','-m',message);git(ilai,'push','-q','origin','HEAD')};
 const show=id=>JSON.parse(git(bare,'show',`main:tasks/${id}.json`));
 return {root,bare,ilai,app,push,show};
}
const shift=ms=>romeIso(new Date(Date.now()+ms));

test('romeIso carries the Europe/Rome offset and parses back to the same instant',()=>{
 for(const [iso,offset] of [['2026-10-20T14:21:03.120Z','+02:00'],['2026-12-01T09:00:00.005Z','+01:00']]){
  const d=new Date(iso),out=romeIso(d);
  assert.match(out,/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}[+-]\d\d:\d\d$/);assert.ok(out.endsWith(offset),out);assert.equal(Date.parse(out),d.getTime());
 }
 assert.equal(romeIso(new Date('2026-10-20T14:21:03.120Z')),'2026-10-20T16:21:03.120+02:00');
});

test('personal tasks stay in one local file and never touch git',async()=>{
 const t=setup();try{
  const nobody=createTodos(fs.mkdtempSync(path.join(t.root,'nobody-')),{remote:'file://'+t.bare,user:()=>'',changed:()=>{}});
  await assert.rejects(nobody.save('personal',{title:'x'}),/Choose who you are/);
  const app=t.app('livio');
  await assert.rejects(app.save('personal',{title:'  '}),/needs a title/);
  await assert.rejects(app.save('personal',{title:'x',status:'later'}),/Invalid status/);
  let list=await app.save('personal',{title:'Buy milk',product:'Home',assignee:null});
  assert.equal(list.personal.length,1);const task=list.personal[0];
  assert.deepEqual([task.title,task.status,task.assignee,task.product,task.createdBy,task.updatedBy],['Buy milk','open',null,'Home','livio','livio']);
  assert.match(task.id,/^[0-9a-f-]{36}$/);assert.ok(task.createdAt.endsWith('+02:00')||task.createdAt.endsWith('+01:00'));
  list=await app.save('personal',{id:task.id,status:'done'});assert.equal(list.personal[0].status,'done');assert.equal(list.personal[0].title,'Buy milk');
  assert.deepEqual(read(app.personalFile).map(x=>x.status),['done']);
  assert.equal(fs.existsSync(app.personalFile+'.tmp'),false);
  await assert.rejects(app.save('personal',{id:'../../etc',title:'x'}),/Invalid task id/);
  list=await app.remove('personal',task.id);assert.equal(list.personal.length,0);
  assert.equal(fs.existsSync(path.join(t.root,'livio-app','build-tasks')),false,'personal work must not clone the shared repo');
  assert.equal(git(t.bare,'log','--format=%s','main').trim(),'seed');
 }finally{fs.rmSync(t.root,{recursive:true,force:true})}
});

test('shared tasks round-trip between two Macs through the repo',async()=>{
 const t=setup();try{
  const app=t.app('livio');
  let list=await app.sync();assert.equal(list.sync.error,null);assert.ok(list.sync.lastSync);assert.equal(list.shared.length,0);
  list=await app.save('shared',{title:'Fix login',product:'ManyMotions',assignee:'ilai',notes:'500 on /auth'});
  const task=list.shared[0];assert.equal(list.sync.error,null);
  assert.equal(t.show(task.id).title,'Fix login');
  assert.equal(git(t.bare,'log','-1','--format=%s','main').trim(),'livio: add Fix login');
  git(t.ilai,'pull','-q','--rebase');assert.deepEqual(read(path.join(t.ilai,'tasks',task.id+'.json')),task);
  t.push({...task,status:'doing',updatedAt:romeIso(),updatedBy:'ilai'},'ilai: start Fix login');
  assert.equal(app.list().shared[0].status,'open','nothing changes before a sync');
  list=await app.sync();assert.equal(list.shared[0].status,'doing');assert.equal(list.shared[0].updatedBy,'ilai');
  list=await app.save('shared',{id:task.id,status:'done'});assert.equal(git(t.bare,'log','-1','--format=%s','main').trim(),'livio: done Fix login');
  list=await app.save('shared',{id:task.id,assignee:'both'});assert.equal(git(t.bare,'log','-1','--format=%s','main').trim(),'livio: assign to both Fix login');
  list=await app.remove('shared',task.id);assert.equal(list.shared.length,0);
  assert.equal(git(t.bare,'log','-1','--format=%s','main').trim(),'livio: delete Fix login');
  assert.throws(()=>git(t.bare,'cat-file','-e',`main:tasks/${task.id}.json`));
 }finally{fs.rmSync(t.root,{recursive:true,force:true})}
});

test('a rejected push takes the other commits and goes through',async()=>{
 const t=setup();try{
  const livio=t.app('livio'),ilai=t.app('ilai');await livio.sync();await ilai.sync();
  await ilai.save('shared',{title:'From Ilai'});
  const list=await livio.save('shared',{title:'From Livio'});
  assert.equal(list.sync.error,null);
  assert.deepEqual(list.shared.map(x=>x.title).sort(),['From Ilai','From Livio']);
  assert.deepEqual(git(t.bare,'log','--format=%s','main').trim().split('\n'),['livio: add From Livio','ilai: add From Ilai','seed']);
 }finally{fs.rmSync(t.root,{recursive:true,force:true})}
});

test('same task changed on both sides: the newer local edit wins, the other stays in history',async()=>{
 const t=setup();try{
  const app=t.app('livio');await app.sync();
  const task=(await app.save('shared',{title:'Shared plan'})).shared[0];
  t.push({...task,title:'Ilai older edit',updatedAt:shift(-60_000),updatedBy:'ilai'},'ilai: edit Ilai older edit');
  const list=await app.save('shared',{id:task.id,title:'Livio newer edit'});
  assert.equal(list.sync.error,null);
  assert.equal(t.show(task.id).title,'Livio newer edit');assert.equal(list.shared[0].title,'Livio newer edit');
  const log=git(t.bare,'log','-p','main','--',`tasks/${task.id}.json`);
  assert.match(log,/Ilai older edit/);assert.match(log,/Livio newer edit/);
  assert.doesNotMatch(git(t.bare,'log','--format=%s','main'),/keep newer/);
 }finally{fs.rmSync(t.root,{recursive:true,force:true})}
});

test('same task changed on both sides: the newer remote edit wins, the local one stays in history',async()=>{
 const t=setup();try{
  const app=t.app('livio');await app.sync();
  const task=(await app.save('shared',{title:'Shared plan'})).shared[0];
  t.push({...task,title:'Ilai newer edit',updatedAt:shift(3_600_000),updatedBy:'ilai'},'ilai: edit Ilai newer edit');
  const list=await app.save('shared',{id:task.id,title:'Livio older edit'});
  assert.equal(list.sync.error,null);
  assert.equal(t.show(task.id).title,'Ilai newer edit');assert.equal(list.shared[0].title,'Ilai newer edit');
  const subjects=git(t.bare,'log','--format=%s','main').trim().split('\n');
  assert.deepEqual(subjects.slice(0,3),['livio: keep newer Ilai newer edit','livio: edit Livio older edit','ilai: edit Ilai newer edit']);
  assert.match(git(t.bare,'log','-p','main','--',`tasks/${task.id}.json`),/Livio older edit/);
  git(t.ilai,'pull','-q','--rebase');assert.equal(read(path.join(t.ilai,'tasks',task.id+'.json')).title,'Ilai newer edit');
 }finally{fs.rmSync(t.root,{recursive:true,force:true})}
});

test('an edit beats a delete made at the same time',async()=>{
 const t=setup();try{
  const app=t.app('livio');await app.sync();
  const task=(await app.save('shared',{title:'Keep me'})).shared[0];
  t.push({...task,notes:'still needed',updatedAt:romeIso(),updatedBy:'ilai'},'ilai: edit Keep me');
  const list=await app.remove('shared',task.id);
  assert.equal(list.sync.error,null);
  assert.equal(t.show(task.id).notes,'still needed');assert.equal(list.shared.length,1);
  assert.match(git(t.bare,'log','--format=%s','main'),/livio: delete Keep me/);
 }finally{fs.rmSync(t.root,{recursive:true,force:true})}
});

test('an unreachable repo keeps the commit and the next sync pushes it',async()=>{
 const t=setup();try{
  const app=t.app('livio');await app.sync();
  fs.renameSync(t.bare,t.bare+'.away');
  let list=await app.save('shared',{title:'Offline task'});
  assert.ok(list.sync.error,'the push error is visible');assert.equal(list.shared[0].title,'Offline task');
  fs.renameSync(t.bare+'.away',t.bare);
  list=await app.sync();assert.equal(list.sync.error,null);
  assert.equal(t.show(list.shared[0].id).title,'Offline task');
 }finally{fs.rmSync(t.root,{recursive:true,force:true})}
});

test('no repository configured: shared work is refused, personal still works',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'terminai-todos-off-'));try{
  const app=createTodos(root,{remote:'',user:()=>'livio',changed:()=>{}});
  assert.equal(app.list().sync.enabled,false);assert.ok(app.list().sync.error);
  await assert.rejects(app.save('shared',{title:'x'}),/No shared repository/);
  assert.equal((await app.sync()).shared.length,0);
  assert.equal((await app.save('personal',{title:'ok'})).personal.length,1);
  assert.equal(fs.existsSync(path.join(root,'build-tasks')),false);
 }finally{fs.rmSync(root,{recursive:true,force:true})}
});
