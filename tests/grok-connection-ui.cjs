// Bots (Settings › Connections): several saved, encrypted, key never shown again; a test ping and
// `terminai ask-grok [--bot]` reach the right webhook with its header; the old single Grok Bot file still loads.
const {app}=require('electron'),fs=require('fs'),os=require('os'),path=require('path'),http=require('http'),cp=require('child_process'),assert=require('assert/strict');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'terminai-grok-'));app.setPath('userData',dir);
fs.writeFileSync(path.join(dir,'prefs.json'),JSON.stringify({seenWelcome:true,tabs:[],voice:{enabled:false},newTabAgent:'none'}));
const delay=ms=>new Promise(r=>setTimeout(r,ms)),got=[];
const hook=http.createServer((q,r)=>{let b='';q.on('data',c=>b+=c);q.on('end',()=>{got.push({path:q.url,auth:q.headers.authorization,body:JSON.parse(b)});r.end('{}')})});
app.on('browser-window-created',(_e,win)=>win.webContents.once('did-finish-load',()=>{void(async()=>{
  await delay(1500);await new Promise(r=>hook.listen(0,'127.0.0.1',r));const js=s=>win.webContents.executeJavaScript(s);
  const url=p=>`http://127.0.0.1:${hook.address().port}/${p}`;
  let list=await js(`window.term.teamchat.botSave({name:'Grok Bot',url:${JSON.stringify(url('grok'))},key:'whk_one',header:'Authorization: Bearer <key>'})`);
  list=await js(`window.term.teamchat.botSave({name:'Support Bot',url:${JSON.stringify(url('support'))},key:'whk_two',header:'',agent:'support'})`);
  assert.equal(list.length,2);assert.ok(list[0].isDefault&&!list[1].isDefault,'the first is the default');
  assert.ok(!JSON.stringify(list).includes('whk_'),'keys never come back');assert.ok(!fs.readFileSync(path.join(dir,'connections.enc')).includes('whk_'),'encrypted');
  await assert.rejects(js(`window.term.teamchat.botSave({name:'grok bot'})`),/already a bot/);
  list=await js(`window.term.teamchat.botTest(${JSON.stringify(list[1].id)})`);assert.equal(list[1].status.ok,true);
  assert.equal(got[0].path,'/support');assert.equal(got[0].auth,'Bearer whk_two');assert.equal(got[0].body.session_id,null);
  const control=path.join(dir,'control.json'),tab=(await js(`window.term.pty.list()`))[0].id;
  const ask=args=>new Promise((res,rej)=>cp.execFile(process.execPath,[path.resolve('resources/terminai.cjs'),'ask-grok',...args],{env:{...process.env,ELECTRON_RUN_AS_NODE:'1',TERMINAI_CONTROL:control,TERMINAI_TAB_ID:tab}},(e,so,se)=>e?rej(Error(se||e.message)):res(so)));
  assert.match(await ask(['Is','it','green?']),/Grok Bot/);assert.equal(got[1].path,'/grok');assert.equal(got[1].auth,'Bearer whk_one');assert.equal(got[1].body.question,'Is it green?');
  assert.match(await ask(['Refund?','--bot','support']),/Support Bot/);assert.equal(got[2].path,'/support');assert.equal(got[2].body.agent,'support');
  list=await js(`window.term.teamchat.botRemove(${JSON.stringify(list[0].id)})`);assert.equal(list.length,1);assert.ok(list[0].isDefault,'the default moves on');
  console.log('PASS bots: several saved encrypted, test and ask-grok reach the right webhook (--bot), default moves on removal');app.quit();
 })().catch(e=>{console.error(e);app.exit(1)})}));
setTimeout(()=>app.exit(1),40000).unref();require('../out/main/index.js');
