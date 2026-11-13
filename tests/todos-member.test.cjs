// The To-do store on a workspace member's Mac (no repo, no partner column): the shared page through the server only.
// Run with: node --test tests/todos-member.test.cjs
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{execFileSync}=require('node:child_process');
const {buildSync}=require('esbuild');
const bundled=buildSync({entryPoints:[path.join(__dirname,'../src/main/todos.ts')],bundle:true,platform:'node',format:'cjs',write:false}).outputFiles[0].text;
const loaded=new module.constructor();loaded._compile(bundled,path.join(__dirname,'todos.bundle.cjs'));
const {createTodos,romeIso}=loaded.exports;
const shift=ms=>romeIso(new Date(Date.now()+ms));

test('a member works through the server only: their key, member columns, the server has the last word',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'terminai-todos-member-'));
 const sofia='u:11111111-1111-4111-8111-111111111111',fritz='u:22222222-2222-4222-8222-222222222222';
 const members=[{key:'ilai',name:'Ilai',products:null},{key:'livio',name:'Matteo',products:null},{key:sofia,name:'Sofia Rossi',products:['ManyMotions.org']},{key:fritz,name:'Fritz Meier',products:['ManyMotions.org']}];
 const store=new Map(),calls=[];let online=true;
 store.set('t-ilai',{id:'t-ilai',title:'From Ilai',notes:'',status:'open',assignee:sofia,product:'ManyMotions.org',createdAt:shift(-5000),createdBy:'ilai',updatedAt:shift(-5000),updatedBy:'ilai'});
 // Like the real server: product limits, and a member's edits signed with their key.
 const server={
  load:async user=>{calls.push(['load',user]);if(!online)throw Error('offline');return {workspace:'w1',tasks:[...store.values()],deleted:[],me:sofia,members}},
  put:async(ws,task)=>{calls.push(['put',task.id]);if(!online)throw Error('offline');if(task.product!=='ManyMotions.org')throw Error('You have no access to that product.');store.set(task.id,{...task,updatedBy:sofia})},
  remove:async(ws,id)=>{calls.push(['remove',id]);store.delete(id)},
 };
 const notes=[];
 const app=createTodos(dir,{remote:'',user:()=>'ilai',key:()=>sofia,serverOnly:()=>true,changed:()=>{},server,notify:c=>notes.push(c)});
 try{
  let list=await app.sync();
  assert.equal(list.server,true);assert.equal(list.me,sofia);assert.equal(list.sync.enabled,true);assert.equal(list.sync.error,null);
  assert.deepEqual(list.shared.map(t=>t.id),['t-ilai']);assert.deepEqual(list.members.map(m=>m.key),['ilai','livio',sofia,fritz]);
  assert.ok(!fs.existsSync(path.join(dir,'build-tasks')),'never a clone');
  assert.ok(calls.every(([kind,user])=>kind!=='load'||user===sofia),'loads as herself');
  // Her task goes to the server at once, signed with her key; one for Fritz's column by his first name.
  list=await app.save('shared',{title:'Landing copy',assignee:sofia,product:'ManyMotions.org'});
  const mine=list.shared.find(t=>t.title==='Landing copy');assert.equal(mine.createdBy,sofia);assert.equal(store.get(mine.id).updatedBy,sofia);
  const added=await app.addTo('fritz','Check the logos');assert.equal(added.page,'Fritz');assert.equal(added.task.assignee,fritz);
  assert.equal(store.get(added.task.id).assignee,fritz);
  await assert.rejects(app.save('shared',{title:'x',assignee:'u:33333333-3333-4333-8333-333333333333'}),/Invalid assignee/);
  // What the server refuses does not stay on screen.
  await assert.rejects(app.save('shared',{title:'Other product',assignee:sofia,product:'ColdWave'}),/no access/);
  assert.ok(!app.list().shared.some(t=>t.title==='Other product'));
  // terminai todo start works on her own task; requests stay between the partners; images stay private.
  assert.equal((await app.track('start','Landing copy')).task.status,'doing');
  await assert.rejects(app.request('Review'),/Requests go between/);
  await assert.rejects(app.addImage('shared',mine.id,Buffer.from('x'),'png'),/Images stay/);
  // Someone else's change comes in with the next sync, with a notice naming its author.
  store.set('t-new',{id:'t-new',title:'From Matteo',notes:'',status:'open',assignee:'both',product:'ManyMotions.org',createdAt:shift(0),createdBy:'livio',updatedAt:shift(0),updatedBy:'livio'});
  list=await app.sync();
  assert.ok(list.unseen.includes('t-new'));assert.equal(notes.at(-1).by,'livio');assert.deepEqual(notes.at(-1).changed.map(t=>t.id),['t-new']);
  // Deleted on the server: gone here too. Offline: an edit fails and says so, and the copy stays the server's.
  store.delete('t-ilai');list=await app.sync();assert.ok(!list.shared.some(t=>t.id==='t-ilai'));
  online=false;await assert.rejects(app.save('shared',{id:mine.id,title:'Offline edit'}),/offline/);
  online=true;list=await app.sync();assert.equal(list.shared.find(t=>t.id===mine.id).title,'Landing copy');
  // A private task made shared lands in her column.
  list=await app.save('personal',{title:'Draft',product:'ManyMotions.org'});
  list=await app.move('personal',list.personal[0].id);assert.equal(list.shared.find(t=>t.title==='Draft').assignee,sofia);
  // terminai todo map lists the member columns, hers first.
  fs.writeFileSync(path.join(dir,'prefs.json'),JSON.stringify({tasksUser:'ilai',teamTasks:true,tasksKey:sofia}));
  const map=JSON.parse(execFileSync(process.execPath,[path.join(__dirname,'../resources/terminai.cjs'),'todo','map'],{encoding:'utf8',env:{...process.env,TERMINAI_TODO_DIR:dir,TERMINAI_TASKS_DIR:path.join(dir,'build-tasks','tasks')}}));
  assert.equal(map.you,sofia);assert.deepEqual(map.shared.map(c=>c.to),['sofia','ilai','together','matteo','unassigned','fritz']);
  assert.deepEqual(map.shared[0].tasks.map(t=>t.title).sort(),['Draft','Landing copy']);assert.deepEqual(map.shared[5].tasks.map(t=>t.title),['Check the logos']);
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
});

// A partner's Mac: the git repo as before, plus the members the server lists, whose columns take tasks.
test('a partner can assign a task to a member once the server has listed them',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'terminai-todos-partner-')),bare=path.join(root,'tasks.git'),seed=path.join(root,'seed');
 const git=(cwd,...args)=>execFileSync('git',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']});
 git(root,'init','-q','--bare','-b','main',bare);git(root,'clone','-q',bare,seed);fs.mkdirSync(path.join(seed,'tasks'));fs.writeFileSync(path.join(seed,'tasks/.gitkeep'),'');
 git(seed,'add','-A');git(seed,'commit','-q','-m','seed');git(seed,'push','-q','origin','HEAD:main');
 const sofia='u:11111111-1111-4111-8111-111111111111',put=[];
 const server={load:async()=>({workspace:'w1',tasks:[],deleted:[],me:'ilai',members:[{key:'ilai',name:'Ilai',products:null},{key:sofia,name:'Sofia',products:['ManyMotions.org']}]}),put:async(ws,task)=>{put.push(task)},remove:async()=>{}};
 const dir=path.join(root,'app');fs.mkdirSync(dir);
 const app=createTodos(dir,{remote:'file://'+bare,user:()=>'ilai',changed:()=>{},server});
 try{
  await app.sync();await app.sync();
  assert.equal(app.list().me,'ilai');assert.equal(app.list().server,false);
  const list=await app.save('shared',{title:'For Sofia',assignee:sofia,product:'ManyMotions.org'});
  const task=list.shared.find(t=>t.title==='For Sofia');assert.equal(task.assignee,sofia);assert.equal(task.createdBy,'ilai');
  assert.equal(JSON.parse(git(bare,'show',`main:tasks/${task.id}.json`)).assignee,sofia,'in the repo');
  assert.ok(put.some(t=>t.id===task.id),'and on the server');
 }finally{fs.rmSync(root,{recursive:true,force:true})}
});
