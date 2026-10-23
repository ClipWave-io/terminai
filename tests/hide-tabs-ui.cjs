// Hiding sessions in the rail: a folder heading counts its hidden ones, shows them on demand,
// unhides one, and the choice survives in prefs.json. Isolated profile, plain shells only.
const {app}=require('electron'),fs=require('fs'),os=require('os'),path=require('path'),assert=require('assert/strict');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'terminai-hide-ui-'));app.setPath('userData',dir);
const a=path.join(dir,'alpha'),b=path.join(dir,'beta');fs.mkdirSync(a);fs.mkdirSync(b);
const tab=(cwd,title,hidden)=>({cwd,title,customTitle:title,hidden,notes:'',focusedMs:0});
fs.writeFileSync(path.join(dir,'prefs.json'),JSON.stringify({seenWelcome:true,groupByFolder:true,voice:{enabled:false},railWidth:300,tabs:[tab(a,'a-one'),tab(a,'a-two',true),tab(a,'a-three'),tab(b,'b-one')]}));
const delay=ms=>new Promise(r=>setTimeout(r,ms));
app.on('browser-window-created',(_e,win)=>win.webContents.once('did-finish-load',()=>{void(async()=>{
 const js=c=>win.webContents.executeJavaScript(c);
 const rows=()=>js(`Array.from(document.querySelectorAll('.rail .tab-title')).map(e=>e.textContent)`);
 const saved=()=>JSON.parse(fs.readFileSync(path.join(dir,'prefs.json'),'utf8')).tabs.map(t=>t.customTitle+(t.hidden?':hidden':''));
 for(let i=0;i<60&&(await rows()).length<3;i++)await delay(150);
 assert.deepEqual(await rows(),['a-one','a-three','b-one']);
 const toggle=`Array.from(document.querySelectorAll('.rail-group')).find(g=>g.textContent.includes('alpha')).querySelector('.rail-hidden-toggle')`;
 assert.equal(await js(`${toggle}.textContent`),'1 hidden');
 assert.equal(await js(`document.querySelectorAll('.rail-hidden-toggle').length`),1);
 await js(`${toggle}.click()`);await delay(100);
 assert.deepEqual(await rows(),['a-one','a-two','a-three','b-one']);
 assert.equal(await js(`${toggle}.textContent`),'Hide 1');
 assert.equal(await js(`document.querySelector('.tab.is-hidden .tab-title').textContent`),'a-two');
 const button=name=>`Array.from(document.querySelectorAll('.rail .tab')).find(t=>t.querySelector('.tab-title').textContent==='${name}').querySelector('.tab-hide')`;
 await js(`${button('a-two')}.dispatchEvent(new MouseEvent('mousedown',{bubbles:true}))`);await delay(100);
 assert.equal(await js(`document.querySelectorAll('.tab.is-hidden').length`),0);
 assert.equal(await js(`document.querySelectorAll('.rail-hidden-toggle').length`),0);
 await js(`${button('b-one')}.dispatchEvent(new MouseEvent('mousedown',{bubbles:true}))`);await delay(100);
 assert.deepEqual(await rows(),['a-one','a-two','a-three']);
 assert.equal(await js(`Array.from(document.querySelectorAll('.rail-group')).find(g=>g.textContent.includes('beta')).querySelector('.rail-hidden-toggle').textContent`),'1 hidden');
 for(let i=0;i<40&&!saved().includes('b-one:hidden');i++)await delay(100);
 assert.deepEqual(saved(),['a-one','a-two','a-three','b-one:hidden']);
 fs.writeFileSync('/tmp/terminai-hide-tabs.png',(await win.capturePage()).toPNG());
 console.log('PASS hide sessions: folder heading counts hidden, shows and tucks them, unhide/hide per row, saved to prefs');app.quit();
})().catch(e=>{console.error(e);app.exit(1)})}));
setTimeout(()=>{console.error('UI timeout');app.exit(1)},20000).unref();
require('../out/main/index.js');
