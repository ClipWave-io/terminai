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
  assert.deepEqual(read(app.personalFile('livio')).map(x=>x.status),['done']);
  assert.equal(fs.existsSync(app.personalFile('livio')+'.tmp'),false);
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

test('private ⇄ shared moves keep the task, its id and dates',async()=>{
 const t=setup();try{
  const app=t.app('livio');await app.sync();
  const task=(await app.save('personal',{title:'Draft the pitch',notes:'two slides'})).personal[0];
  let list=await app.move('personal',task.id);
  assert.equal(list.sync.error,null);assert.equal(list.personal.length,0);assert.deepEqual(read(app.personalFile('livio')),[]);
  const shared=t.show(task.id);
  assert.deepEqual([shared.id,shared.title,shared.notes,shared.assignee,shared.createdAt,shared.createdBy,shared.updatedBy],[task.id,'Draft the pitch','two slides','livio',task.createdAt,'livio','livio']);
  assert.equal(git(t.bare,'log','-1','--format=%s','main').trim(),'livio: share Draft the pitch');
  list=await app.move('shared',task.id);
  assert.equal(list.shared.length,0);assert.throws(()=>git(t.bare,'cat-file','-e',`main:tasks/${task.id}.json`));
  assert.equal(git(t.bare,'log','-1','--format=%s','main').trim(),'livio: make private Draft the pitch');
  assert.deepEqual(read(app.personalFile('livio')).map(x=>[x.id,x.title,x.assignee,x.createdAt]),[[task.id,'Draft the pitch',null,task.createdAt]]);
  // To someone else's column: shared and assigned in one step.
  list=await app.move('personal',task.id,'both');assert.equal(t.show(task.id).assignee,'both');assert.equal(list.personal.length,0);
  await assert.rejects(app.move('shared',task.id,'everyone'),/Invalid assignee/);
  await assert.rejects(app.move('personal','missing-id'),/no longer exists/);
 }finally{fs.rmSync(t.root,{recursive:true,force:true})}
});

test('a move that fails leaves the task where it was',async()=>{
 const t=setup();try{
  const app=t.app('livio');await app.sync();
  const clone=path.join(t.root,'livio-app','build-tasks'),lock=path.join(clone,'.git','index.lock');
  // To shared, the commit fails (index locked): still private, and the clone is left clean for the next sync.
  const mine=(await app.save('personal',{title:'Stay private'})).personal[0];
  fs.writeFileSync(lock,'');
  await assert.rejects(app.move('personal',mine.id),/index\.lock/);
  fs.rmSync(lock);
  assert.deepEqual(read(app.personalFile('livio')).map(x=>x.id),[mine.id]);
  assert.equal(git(clone,'status','--porcelain').trim(),'');
  // To private, the delete commit fails: still shared, file back in the clone, not in the private list.
  const ours=(await app.save('shared',{title:'Stay shared',assignee:'both'})).shared[0];
  fs.writeFileSync(lock,'');
  await assert.rejects(app.move('shared',ours.id),/index\.lock/);
  fs.rmSync(lock);
  assert.deepEqual(read(app.personalFile('livio')).map(x=>x.id),[mine.id]);
  assert.equal(git(clone,'status','--porcelain').trim(),'');assert.equal(t.show(ours.id).title,'Stay shared');
  // To private, the private file cannot be written: nothing leaves the repo.
  fs.rmSync(app.personalFile('livio'));fs.mkdirSync(app.personalFile('livio'));
  await assert.rejects(app.move('shared',ours.id));
  fs.rmdirSync(app.personalFile('livio'));
  assert.equal(t.show(ours.id).title,'Stay shared');assert.equal(git(clone,'status','--porcelain').trim(),'');
  const list=await app.sync();assert.equal(list.sync.error,null);
  assert.deepEqual(git(t.bare,'log','--format=%s','main').trim().split('\n'),['livio: add Stay shared','seed']);
 }finally{fs.rmSync(t.root,{recursive:true,force:true})}
});

test('private tasks are per user; the old per-Mac file is split by who created each task',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'terminai-todos-users-'));try{
  const now=romeIso(),task=(id,createdBy)=>({id,title:id,notes:'',status:'open',assignee:null,product:'',createdAt:now,createdBy,updatedAt:now,updatedBy:createdBy});
  fs.writeFileSync(path.join(root,'todos-personal.json'),JSON.stringify([task('a','livio'),task('b','ilai'),task('c','')]));
  let user='livio';const app=createTodos(root,{remote:'',user:()=>user,changed:()=>{}});
  assert.deepEqual(app.list().personal.map(x=>x.id),['a','c']);
  assert.equal(fs.existsSync(path.join(root,'todos-personal.json')),false);assert.equal(fs.existsSync(path.join(root,'todos-personal.json.migrated')),true);
  user='ilai';assert.deepEqual(app.list().personal.map(x=>x.id),['b']);
  await app.save('personal',{title:'Ilai only'});
  user='livio';assert.deepEqual(app.list().personal.map(x=>x.title),['a','c']);
  user='';assert.deepEqual(app.list().personal,[]);
 }finally{fs.rmSync(root,{recursive:true,force:true})}
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

test('order is saved and read back; a file without it still loads and an edit does not add one',async()=>{
 const t=setup();try{
  const app=t.app('livio');await app.sync();
  let mine=(await app.save('personal',{title:'Ordered',order:1234.5})).personal[0];
  assert.equal(read(app.personalFile('livio'))[0].order,1234.5);
  mine=(await app.save('personal',{id:mine.id,title:'Ordered, renamed'})).personal[0];assert.equal(mine.order,1234.5);
  const stamp=mine.updatedAt;await new Promise(r=>setTimeout(r,5));
  mine=(await app.save('personal',{id:mine.id,order:99})).personal[0];
  assert.equal(mine.order,99);assert.equal(mine.updatedAt,stamp,'moving a task up or down is not an edit');
  await assert.rejects(app.save('personal',{id:mine.id,order:NaN}),/Invalid order/);
  await assert.rejects(app.save('personal',{id:mine.id,order:'3'}),/Invalid order/);
  // A task written before order existed, pushed from the other Mac.
  const now=romeIso(),old={id:'no-order-task',title:'Old format',notes:'',status:'open',assignee:'both',product:'',createdAt:now,createdBy:'ilai',updatedAt:now,updatedBy:'ilai'};
  t.push(old,'ilai: add Old format');
  let list=await app.sync();const got=list.shared.find(x=>x.id===old.id);
  assert.deepEqual(got,old);assert.equal('order' in got,false);
  await app.save('shared',{id:old.id,title:'Old format, edited'});
  const edited=t.show(old.id);assert.equal('order' in edited,false,'an edit does not add an order');
  list=await app.save('shared',{id:old.id,order:42});
  assert.equal(t.show(old.id).order,42);assert.equal(t.show(old.id).updatedAt,edited.updatedAt);assert.equal(list.shared.find(x=>x.id===old.id).order,42);
  assert.equal(git(t.bare,'log','-1','--format=%s','main').trim(),'livio: reorder Old format, edited');
  assert.deepEqual(Object.keys(t.show(old.id)),['id','title','notes','status','assignee','product','order','createdAt','createdBy','updatedAt','updatedBy']);
 }finally{fs.rmSync(t.root,{recursive:true,force:true})}
});

test('batches are one commit each and restore puts back the very same files',async()=>{
 const t=setup();try{
  const app=t.app('livio');await app.sync();
  const commits=()=>Number(git(t.bare,'rev-list','--count','main')),last=()=>git(t.bare,'log','-1','--format=%s','main').trim();
  let list=await app.saveMany('shared',[{title:'One',assignee:'both',notes:'n1'},{title:'Two',assignee:'both',order:5},{title:'Three',assignee:'ilai',product:'X'},{title:'Four'}]);
  assert.equal(last(),'livio: add One, Two, Three and 1 more');assert.equal(list.shared.length,4);
  const ids=['One','Two','Three','Four'].map(title=>list.shared.find(x=>x.title===title).id);
  let n=commits();
  list=await app.saveMany('shared',[{id:ids[0],assignee:'ilai',order:7},{id:ids[1],order:8}]);
  assert.equal(commits(),n+1);assert.equal(last(),'livio: move One, Two');
  assert.deepEqual([t.show(ids[0]).assignee,t.show(ids[0]).order,t.show(ids[1]).order],['ilai',7,8]);
  await assert.rejects(app.saveMany('shared',[{id:ids[2],title:'ok'},{id:'missing',title:'x'}]),/no longer exists/);
  assert.equal(t.show(ids[2]).title,'Three','a batch with a bad input writes nothing');
  const before=ids.slice(0,3).map(id=>list.shared.find(x=>x.id===id)),bytes=ids.slice(0,3).map(id=>git(t.bare,'show',`main:tasks/${id}.json`));
  n=commits();list=await app.removeMany('shared',ids.slice(0,3));
  assert.equal(commits(),n+1);assert.equal(last(),'livio: delete One, Two, Three');assert.deepEqual(list.shared.map(x=>x.id),[ids[3]]);
  for(const id of ids.slice(0,3))assert.throws(()=>git(t.bare,'cat-file','-e',`main:tasks/${id}.json`));
  await assert.rejects(app.restore('shared',[{...before[0],status:'later'}]),/Invalid task/);
  await assert.rejects(app.restore('shared',[{...before[0],createdAt:undefined}]),/Invalid task/);
  assert.equal(commits(),n+1);
  list=await app.restore('shared',before);
  assert.equal(commits(),n+2);assert.equal(last(),'livio: restore One, Two, Three');
  assert.deepEqual(ids.slice(0,3).map(id=>git(t.bare,'show',`main:tasks/${id}.json`)),bytes,'the same bytes as before the delete');
  assert.deepEqual(before.map(x=>list.shared.find(y=>y.id===x.id)),before);
  await app.restore('shared',before);assert.equal(commits(),n+2,'nothing to commit when the files already say it');
  // Private: delete and put back; move with an order on both sides.
  const p=(await app.save('personal',{title:'Mine',notes:'keep'})).personal[0];
  await app.removeMany('personal',[p.id]);assert.deepEqual(read(app.personalFile('livio')),[]);
  list=await app.restore('personal',[p]);assert.deepEqual(read(app.personalFile('livio')),[p]);
  list=await app.move('personal',p.id,'both',9.5);assert.deepEqual([t.show(p.id).assignee,t.show(p.id).order,t.show(p.id).createdAt],['both',9.5,p.createdAt]);
  list=await app.move('shared',ids[3],undefined,3.25);assert.equal(read(app.personalFile('livio')).find(x=>x.id===ids[3]).order,3.25);
  await assert.rejects(app.move('shared',p.id,undefined,Infinity),/Invalid order/);
  await assert.rejects(app.removeMany('shared',['../x']),/Invalid task id/);
 }finally{fs.rmSync(t.root,{recursive:true,force:true})}
});

test('what the other Mac changed shows as unseen, is notified once, and keeps its history',async()=>{
 const t=setup();try{
  const notes=[],dir=path.join(t.root,'livio-app');fs.mkdirSync(dir,{recursive:true});
  const app=createTodos(dir,{remote:'file://'+t.bare,user:()=>'livio',changed:()=>{},notify:c=>notes.push(c)});
  let list=await app.save('shared',{title:'Fix login',notes:'line one\nline two',assignee:'both'});
  const task=list.shared[0];
  assert.deepEqual(list.unseen,[],'my own task is never unseen');
  t.push({...task,notes:'line one\nline 2 changed',updatedAt:shift(1000),updatedBy:'ilai'},'ilai: edit Fix login');
  const added={id:require('node:crypto').randomUUID(),title:'Deploy',notes:'',status:'open',assignee:'ilai',product:'',createdAt:shift(2000),createdBy:'ilai',updatedAt:shift(2000),updatedBy:'ilai'};
  t.push(added,'ilai: add Deploy');
  list=await app.sync();
  assert.deepEqual([...list.unseen].sort(),[task.id,added.id].sort());
  assert.equal(notes.length,1);assert.equal(notes[0].by,'ilai');assert.deepEqual(notes[0].changed.map(x=>x.title).sort(),['Deploy','Fix login']);
  list=await app.sync();assert.equal(notes.length,1,'nothing new, no second notice');assert.equal(list.unseen.length,2);
  const h=await app.history(task.id);
  assert.deepEqual(h.map(v=>v.message),['ilai: edit Fix login','livio: add Fix login']);
  assert.deepEqual(h.map(v=>v.by),['ilai','livio']);
  assert.equal(h[0].task.notes,'line one\nline 2 changed');assert.equal(h[1].task.notes,'line one\nline two');
  list=app.markSeen([task.id]);assert.deepEqual(list.unseen,[added.id]);
  list=await app.save('shared',{id:added.id,title:'Deploy v2'});assert.deepEqual(list.unseen,[],'an edit of mine is seen');
  git(t.ilai,'pull','-q','--rebase');git(t.ilai,'rm','-q',`tasks/${added.id}.json`);git(t.ilai,'commit','-q','-m','ilai: delete Deploy v2');git(t.ilai,'push','-q','origin','HEAD');
  list=await app.sync();assert.deepEqual(notes[1].removed,['Deploy v2']);assert.deepEqual(notes[1].changed,[]);
  assert.equal((await app.history(added.id))[0].task,null,'the delete is in the history');
  await assert.rejects(app.history('../x'),/Invalid task id/);
  const other=t.app('livio2','livio');assert.deepEqual(other.list().unseen,[]);
  assert.deepEqual((await other.sync()).unseen,[],'a first clone takes everything as seen');
 }finally{fs.rmSync(t.root,{recursive:true,force:true})}
});

test('images: a shared task carries its pictures through the repo, once each, and back after an undo',async()=>{
 const t=setup();try{
  const livio=t.app('livio'),ilai=t.app('ilai');
  let list=await livio.save('shared',{title:'Fix the logo',assignee:'both'});const id=list.shared[0].id;
  const png=Buffer.from('fake png bytes for the test');
  await assert.rejects(livio.addImage('shared',id,Buffer.alloc(0),'png'),/too large/);
  await assert.rejects(livio.addImage('shared','../x',png,'png'),/Invalid task id/);
  list=await livio.addImage('shared',id,png,'png');
  const name=list.shared[0].images[0];assert.match(name,/^[0-9a-f]{12}\.png$/);
  assert.equal(git(t.bare,'show',`main:images/${id}/${name}`),png.toString(),'the picture is in the repo');
  assert.deepEqual(t.show(id).images,[name]);assert.match(git(t.bare,'log','-1','--format=%s','main').trim(),/^livio: add image to Fix the logo$/);
  list=await livio.addImage('shared',id,png,'png');assert.deepEqual(list.shared[0].images,[name],'the same picture twice is kept once');
  await livio.save('shared',{id,title:'Fix the new logo'});assert.deepEqual(t.show(id).images,[name],'editing the task keeps its images');
  list=await ilai.sync();assert.deepEqual(list.shared[0].images,[name]);
  const there=ilai.imagePath('shared',id,name);assert.ok(there&&fs.readFileSync(there).equals(png),'the other Mac has the file');
  assert.equal(ilai.imagePath('shared',id,'000000000000.png'),'');assert.throws(()=>ilai.imagePath('shared',id,'../../x.png'),/Invalid image/);
  const jpg=Buffer.from('second picture');list=await ilai.addImage('shared',id,jpg,'jpg');const second=list.shared[0].images[1];
  list=await ilai.removeImage('shared',id,name);assert.deepEqual(list.shared[0].images,[second]);
  assert.throws(()=>git(t.bare,'cat-file','-e',`main:images/${id}/${name}`),'removed from the repo');
  // Deleted, then put back by Undo: the picture comes back with the task.
  const task=list.shared[0];
  await ilai.remove('shared',id);assert.throws(()=>git(t.bare,'cat-file','-e',`main:images/${id}/${second}`));
  list=await ilai.restore('shared',[task]);assert.deepEqual(list.shared[0].images,[second]);
  assert.equal(git(t.bare,'show',`main:images/${id}/${second}`),'second picture');
 }finally{fs.rmSync(t.root,{recursive:true,force:true})}
});

test('images: a private task keeps them on this Mac, and they travel when it is shared and made private again',async()=>{
 const t=setup();try{
  const app=t.app('livio');
  let list=await app.save('personal',{title:'Screenshot of the bug'});const id=list.personal[0].id;
  list=await app.addImage('personal',id,Buffer.from('private picture'),'png');const name=list.personal[0].images[0];
  const local=app.imagePath('personal',id,name);assert.ok(local.includes(`${path.sep}todo-images${path.sep}`),local);
  assert.equal(git(t.bare,'log','--all','--format=%s').includes('image'),false,'nothing private reaches git');
  list=await app.move('personal',id,'livio');assert.deepEqual(list.shared[0].images,[name]);
  assert.equal(git(t.bare,'show',`main:images/${id}/${name}`),'private picture');assert.equal(app.imagePath('personal',id,name),'','gone from the private folder');
  list=await app.move('shared',id);assert.deepEqual(list.personal[0].images,[name]);
  assert.throws(()=>git(t.bare,'cat-file','-e',`main:images/${id}/${name}`),'out of the repo once private');
  assert.ok(app.imagePath('personal',id,name));
 }finally{fs.rmSync(t.root,{recursive:true,force:true})}
});

test('terminai todo start|done|reopen: own, Together and private tasks; the link to the tab stays on this Mac',async()=>{
 const t=setup();try{
  let changed=0;const dir=path.join(t.root,'livio-app');fs.mkdirSync(dir,{recursive:true});
  const app=createTodos(dir,{remote:'file://'+t.bare,user:()=>'livio',changed:()=>changed++});
  await app.sync();
  await app.saveMany('shared',[{title:'Fix login page',assignee:'both'},{title:'Fix login emails',assignee:'livio',status:'done'},{title:'Deploy landing',assignee:'livio'},{title:'Call the bank',assignee:'ilai'}]);
  const milk=(await app.save('personal',{title:'Deploy milk run'})).personal[0];
  const session={tab:'browser-key-1',name:'Login work'};
  // A part of the title: the finished task that shares it does not count when starting.
  let r=await app.track('start','fix LOGIN',session);
  assert.deepEqual([r.scope,r.task.title,r.task.status],['shared','Fix login page','doing']);
  assert.equal(git(t.bare,'log','-1','--format=%s','main').trim(),'livio: start Fix login page');
  let list=app.list();assert.deepEqual(Object.keys(list.working),[r.task.id]);
  assert.deepEqual([list.working[r.task.id].tab,list.working[r.task.id].name],['browser-key-1','Login work']);
  // The link is in userData, not in the clone: Ilai gets "in progress" and nothing about the tab.
  assert.ok(fs.existsSync(path.join(dir,'todos-working-livio.json')));
  assert.equal(git(path.join(dir,'build-tasks'),'status','--porcelain').trim(),'');
  git(t.ilai,'pull','-q','--rebase');const theirs=fs.readFileSync(path.join(t.ilai,'tasks',r.task.id+'.json'),'utf8');
  assert.equal(JSON.parse(theirs).status,'doing');assert.equal(theirs.includes('Login work')||theirs.includes('browser-key'),false);
  await assert.rejects(app.track('start','call the bank',session),/“Call the bank” is Ilai’s task/);
  await assert.rejects(app.track('start','deploy',session),/matches 2 tasks: .*Deploy landing.*Deploy milk run/);
  await assert.rejects(app.track('start','nothing like this'),/No task matches/);
  await assert.rejects(app.track('pause','Deploy landing'),/Use start, done or reopen/);
  // A private task by id: no commit, the sheet is told.
  changed=0;r=await app.track('start',milk.id,session);
  assert.deepEqual([r.scope,r.task.status],['personal','doing']);assert.ok(changed>0);assert.ok(app.list().working[milk.id]);
  assert.equal(git(t.bare,'log','-1','--format=%s','main').trim(),'livio: start Fix login page');
  // Done drops the link; so does a task put back to open in the app.
  r=await app.track('done','Fix login page');assert.equal(r.task.status,'done');
  assert.equal(git(t.bare,'log','-1','--format=%s','main').trim(),'livio: done Fix login page');
  r=await app.track('reopen',r.task.id);assert.equal(r.task.status,'open');
  assert.equal(git(t.bare,'log','-1','--format=%s','main').trim(),'livio: reopen Fix login page');
  await app.save('personal',{id:milk.id,status:'open'});
  assert.deepEqual(app.list().working,{});
  // The sessions read it in terminai todo: `session` on the task in progress.
  await app.track('start','Deploy landing',{tab:'k2',name:'Landing'});
  fs.writeFileSync(path.join(dir,'prefs.json'),JSON.stringify({tasksUser:'livio'}));
  const cli=JSON.parse(execFileSync(process.execPath,[path.join(__dirname,'../resources/terminai.cjs'),'todo','--shared'],{encoding:'utf8',env:{...process.env,TERMINAI_TODO_DIR:dir,TERMINAI_TASKS_DIR:path.join(dir,'build-tasks','tasks')}}));
  assert.deepEqual(cli.shared.filter(x=>x.session).map(x=>[x.title,x.session]),[['Deploy landing','Landing']]);
 }finally{fs.rmSync(t.root,{recursive:true,force:true})}
});

test('private lists: named pages, Move to list, delete with a day for Undo, then gone with their tasks',async()=>{
 const t=setup();try{
  const dir=path.join(t.root,'livio-app');fs.mkdirSync(dir,{recursive:true});
  const make=()=>createTodos(dir,{remote:'file://'+t.bare,user:()=>'livio',changed:()=>{}});
  let app=make(),list=app.list();
  assert.deepEqual(list.lists,[{id:'private',name:'Private'}]);
  list=app.addList('Unlocked Tour');const tour=list.lists[1];assert.equal(tour.name,'Unlocked Tour');
  assert.throws(()=>app.addList('  '),/needs a name/);
  list=await app.save('personal',{title:'Call the guide',list:tour.id});const call=list.personal.find(x=>x.title==='Call the guide');assert.equal(call.list,tour.id);
  list=await app.save('personal',{title:'Buy milk'});const milk=list.personal.find(x=>x.title==='Buy milk');assert.equal('list' in milk,false);
  // Move to list, and back to the first one, which is no field at all.
  list=await app.save('personal',{id:milk.id,list:tour.id});assert.equal(list.personal.find(x=>x.id===milk.id).list,tour.id);
  list=await app.save('personal',{id:milk.id,list:'private'});assert.equal('list' in list.personal.find(x=>x.id===milk.id),false);
  await assert.rejects(app.save('personal',{title:'x',list:'nope'}),/That list no longer exists/);
  await assert.rejects(app.save('shared',{title:'x',list:tour.id}),/A shared task is in no list/);
  list=await app.restore('personal',[call]);assert.equal(list.personal.find(x=>x.id===call.id).list,tour.id);
  // Renaming, the first list too; the first one is never deleted.
  list=app.renameList('private','General');list=app.renameList(tour.id,'Unlocked');
  assert.deepEqual(list.lists.map(l=>l.name),['General','Unlocked']);
  assert.throws(()=>app.removeList('private'),/The first list stays/);
  // Shared to private lands in the list asked; private to shared leaves the list behind.
  await app.sync();
  const contract=(await app.save('shared',{title:'Guide contract',assignee:'livio'})).shared[0];
  list=await app.move('shared',contract.id,undefined,undefined,tour.id);assert.equal(list.personal.find(x=>x.id===contract.id).list,tour.id);
  list=await app.move('personal',contract.id,'livio');assert.equal('list' in t.show(contract.id),false);assert.equal('list' in list.shared[0],false);
  // Deleted: out of sight at once, back with restoreList.
  list=app.removeList(tour.id);assert.deepEqual(list.lists.map(l=>l.name),['General']);assert.equal(list.personal.some(x=>x.id===call.id),false);
  list=app.restoreList(tour.id);assert.deepEqual(list.lists.map(l=>l.name),['General','Unlocked']);assert.ok(list.personal.some(x=>x.id===call.id));
  // terminai todo names the list of each private task and leaves a deleted one out.
  fs.writeFileSync(path.join(dir,'prefs.json'),JSON.stringify({tasksUser:'livio'}));
  const cli=()=>JSON.parse(execFileSync(process.execPath,[path.join(__dirname,'../resources/terminai.cjs'),'todo','--personal'],{encoding:'utf8',env:{...process.env,TERMINAI_TODO_DIR:dir}})).personal;
  assert.deepEqual(cli().map(x=>[x.title,x.list]).sort(),[['Buy milk','General'],['Call the guide','Unlocked']]);
  app.removeList(tour.id);assert.deepEqual(cli().map(x=>x.title),['Buy milk']);
  // A day later the list goes for good, with its tasks and their pictures.
  fs.mkdirSync(path.join(dir,'todo-images',call.id),{recursive:true});
  const file=path.join(dir,'todos-lists-livio.json'),pages=read(file);pages.find(p=>p.id===tour.id).deletedAt=romeIso(new Date(Date.now()-25*3600e3));fs.writeFileSync(file,JSON.stringify(pages));
  app=make();
  assert.deepEqual(read(app.personalFile('livio')).map(x=>x.title),['Buy milk']);assert.equal(fs.existsSync(path.join(dir,'todo-images',call.id)),false);
  assert.throws(()=>app.restoreList(tour.id),/That list is gone/);assert.deepEqual(app.list().lists.map(l=>l.name),['General']);
 }finally{fs.rmSync(t.root,{recursive:true,force:true})}
});

test('terminai todo add puts a task where it is told, never in a default page; lists carry what they are for; todo map shows the pages',async()=>{
 const t=setup();try{
  let listsChanged=0;const dir=path.join(t.root,'livio-app');fs.mkdirSync(dir,{recursive:true});
  const app=createTodos(dir,{remote:'file://'+t.bare,user:()=>'livio',changed:()=>{},listsChanged:()=>listsChanged++});
  await app.sync();
  const tour=app.addList('Unlocked Tour').lists[1];app.addList('Unlocked Archive');
  assert.equal(listsChanged,2,'a new list rewrites the map');
  // One name per list: a second "New list" is "New list 2", and a rename cannot take another list's name.
  let named=app.addList('New list');named=app.addList('New list');assert.deepEqual(named.lists.slice(-2).map(l=>l.name),['New list','New list 2']);
  assert.throws(()=>app.renameList(named.lists.at(-1).id,'unlocked tour'),/There is a list called “unlocked tour” already/);
  app.removeList(named.lists.at(-1).id);app.removeList(named.lists.at(-2).id);listsChanged=2;
  let list=app.describeList(tour.id,'  Barcelona tour agency: guides, bookings, the site  ');
  assert.equal(list.lists.find(l=>l.id===tour.id).about,'Barcelona tour agency: guides, bookings, the site');assert.equal(listsChanged,3);
  assert.deepEqual(app.pages().map(p=>[p.name,p.about??null]),[['Private',null],['Unlocked Tour','Barcelona tour agency: guides, bookings, the site'],['Unlocked Archive',null]]);
  assert.throws(()=>app.describeList(tour.id,'x'.repeat(501)),/up to 500/);
  // By name from a tab: the whole name, else a part found in one name only.
  list=app.describeList('unlocked archive','Old bookings',true);assert.equal(list.lists[2].about,'Old bookings');
  assert.throws(()=>app.describeList('unlocked','x',true),/more than one list name/);
  // add: each shared column by its name, a private list by its name; no page, a wrong one or an ambiguous one is refused.
  let r=await app.addTo('together','Call the accountant',' about VAT ');assert.deepEqual([r.scope,r.page,r.task.assignee,r.task.notes],['shared','Together','both','about VAT']);
  assert.equal(git(t.bare,'log','-1','--format=%s','main').trim(),'livio: add Call the accountant');
  r=await app.addTo('Ilai','Check the Whop payouts');assert.deepEqual([r.page,r.task.assignee],['Ilai','ilai']);
  r=await app.addTo('matteo','Renew the domain');assert.equal(r.task.assignee,'livio');
  r=await app.addTo('unassigned','Someone should look at this');assert.equal(r.task.assignee,null);
  r=await app.addTo('Unlocked Tour','Write to the guides');assert.deepEqual([r.scope,r.page,r.task.list],['personal','Unlocked Tour',tour.id]);
  r=await app.addTo('private','Buy milk');assert.deepEqual([r.page,'list' in r.task],['Private',false]);
  await assert.rejects(app.addTo('','x'),/Where\?/);
  await assert.rejects(app.addTo('the agency','x'),/No page “the agency”\. Shared: matteo, together, ilai, unassigned\. Private lists: “Private”, “Unlocked Tour”, “Unlocked Archive”/);
  await assert.rejects(app.addTo('unlocked','x'),/more than one list name/);
  await assert.rejects(app.addTo('together','  '),/needs a title/);
  // The map, as a session reads it.
  fs.writeFileSync(path.join(dir,'prefs.json'),JSON.stringify({tasksUser:'livio'}));
  const map=JSON.parse(execFileSync(process.execPath,[path.join(__dirname,'../resources/terminai.cjs'),'todo','map'],{encoding:'utf8',env:{...process.env,TERMINAI_TODO_DIR:dir,TERMINAI_TASKS_DIR:path.join(dir,'build-tasks','tasks')}}));
  assert.equal(map.you,'livio');
  assert.deepEqual(map.shared.map(c=>[c.page,c.to,c.tasks.map(x=>x.title)]),[['Matteo','matteo',['Renew the domain']],['Together','together',['Call the accountant']],['Ilai','ilai',['Check the Whop payouts']],['Unassigned','unassigned',['Someone should look at this']]]);
  assert.equal(map.shared[1].tasks[0].notes,'about VAT');
  assert.deepEqual(map.private.map(p=>[p.page,p.about,p.tasks.map(x=>x.title)]),[['Private',null,['Buy milk']],['Unlocked Tour','Barcelona tour agency: guides, bookings, the site',['Write to the guides']],['Unlocked Archive','Old bookings',[]]]);
 }finally{fs.rmSync(t.root,{recursive:true,force:true})}
});

test('the server copy: Mac tasks go up, phone edits and deletes come down as commits, Mac deletes reach the server',async()=>{
 const t=setup();try{
  // A fake server as the manager keeps it: tasks, tombstones; the phone writes straight into it.
  const srv={tasks:new Map(),deleted:new Map()};
  const server={
   load:async()=>({workspace:'w1',tasks:[...srv.tasks.values()],deleted:[...srv.deleted.entries()].map(([id,d])=>({id,...d}))}),
   put:async(_w,task)=>{srv.tasks.set(task.id,JSON.parse(JSON.stringify(task)));srv.deleted.delete(task.id)},
   remove:async(_w,id)=>{srv.tasks.delete(id);srv.deleted.set(id,{deletedAt:new Date().toISOString(),by:null})},
  };
  const dir=path.join(t.root,'mac');fs.mkdirSync(dir);
  const app=createTodos(dir,{remote:'file://'+t.bare,user:()=>'ilai',changed:()=>{},server});
  let list=await app.save('shared',{title:'Ship v1',assignee:'both'});const id=list.shared[0].id;
  assert.equal(srv.tasks.get(id).title,'Ship v1','an edit on the Mac reaches the server');
  // Matteo ticks it on his phone, a minute later.
  srv.tasks.set(id,{...srv.tasks.get(id),status:'done',updatedAt:new Date(Date.now()+60000).toISOString(),updatedBy:'livio',updatedVia:'iphone'});
  list=await app.sync();
  assert.equal(list.shared[0].status,'done');assert.equal(t.show(id).status,'done','pushed to the repo for the other Mac');
  assert.equal(t.show(id).updatedVia,undefined);
  assert.match(git(t.bare,'log','-1','--format=%s%n%b','main'),/^livio: done Ship v1\nVia: iPhone app/);
  // A task added on the phone.
  srv.tasks.set('phone1',{id:'phone1',title:'From the phone',notes:'',status:'open',assignee:'ilai',product:'',createdAt:new Date().toISOString(),createdBy:'livio',updatedAt:new Date().toISOString(),updatedBy:'livio'});
  list=await app.sync();assert.ok(list.shared.some(x=>x.id==='phone1'));
  // Deleted on the phone: gone from the repo.
  await server.remove('w1','phone1');srv.deleted.set('phone1',{deletedAt:new Date(Date.now()+120000).toISOString(),by:'livio'});
  list=await app.sync();assert.ok(!list.shared.some(x=>x.id==='phone1'));
  assert.match(git(t.bare,'log','-1','--format=%s','main'),/^livio: delete From the phone/);
  // Deleted on a Mac: gone from the server too.
  await app.remove('shared',id);
  assert.equal(srv.tasks.has(id),false);assert.ok(srv.deleted.has(id));
  // Nothing changed: a sync makes no commit.
  const head=git(t.bare,'rev-parse','main');await app.sync();assert.equal(git(t.bare,'rev-parse','main'),head);
 }finally{fs.rmSync(t.root,{recursive:true,force:true})}
});
