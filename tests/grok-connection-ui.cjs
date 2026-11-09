// Grok Bot connection: save the webhook (encrypted, key never shown again), Send test posts the ping with the
// pasted header, and `terminai ask-grok` from a tab posts the question with that tab's title.
const {app}=require('electron'),fs=require('fs'),os=require('os'),path=require('path'),http=require('http'),cp=require('child_process'),assert=require('assert/strict');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'terminai-grok-'));app.setPath('userData',dir);
fs.writeFileSync(path.join(dir,'prefs.json'),JSON.stringify({seenWelcome:true,tabs:[],voice:{enabled:false},newTabAgent:'none'}));
const delay=ms=>new Promise(r=>setTimeout(r,ms)),got=[];
const hook=http.createServer((q,r)=>{let b='';q.on('data',c=>b+=c);q.on('end',()=>{got.push({auth:q.headers.authorization,body:JSON.parse(b)});r.end('{}')})});
app.on('browser-window-created',(_e,win)=>win.webContents.once('did-finish-load',()=>{void(async()=>{
  await delay(1500);await new Promise(r=>hook.listen(0,'127.0.0.1',r));const js=s=>win.webContents.executeJavaScript(s);
  const url=`http://127.0.0.1:${hook.address().port}/hook`;
  const saved=await js(`window.term.teamchat.grokSave({url:${JSON.stringify(url)},key:'whk_secret',header:'Authorization: Bearer <key>',agent:'general'})`);
  assert.equal(saved.configured,true);assert.ok(!JSON.stringify(saved).includes('whk_secret'),'the key never comes back');
  assert.ok(!fs.readFileSync(path.join(dir,'connections.enc')).includes('whk_secret'),'encrypted on disk');
  const tested=await js(`window.term.teamchat.grokTest()`);assert.equal(tested.status.ok,true);
  assert.equal(got[0].auth,'Bearer whk_secret');assert.equal(got[0].body.session_id,null);
  // From a tab, through the real CLI.
  const control=JSON.parse(fs.readFileSync(path.join(dir,'control.json'),'utf8'));
  const tab=(await js(`window.term.pty.list()`))[0].id;
  const out=await new Promise((res,rej)=>cp.execFile(process.execPath,[path.resolve('resources/terminai.cjs'),'ask-grok','Is','the','build','green?','--agent','ops'],{env:{...process.env,ELECTRON_RUN_AS_NODE:'1',TERMINAI_CONTROL:path.join(dir,'control.json'),TERMINAI_TAB_ID:tab}},(e,so,se)=>e?rej(Error(se||e.message)):res(so)));
  assert.match(out,/Sent/);assert.equal(got[1].body.question,'Is the build green?');assert.equal(got[1].body.agent,'ops');assert.ok(got[1].body.from,'the tab title');
  console.log('PASS grok connection: saved encrypted, test ping and ask-grok reach the webhook with the header');app.quit();
 })().catch(e=>{console.error(e);app.exit(1)})}));
setTimeout(()=>app.exit(1),40000).unref();require('../out/main/index.js');
