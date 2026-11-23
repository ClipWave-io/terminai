// With folders in the sidebar, a new chat in the bottom folder goes at the bottom of that folder (Settings › New chats go:
// at the top, with AT=top): the folders do not move.
// After `npx electron-vite build`: TERMINAI_TEST_BUILD=1 [AT=top] npx electron tests/new-tab-folder-order-ui.cjs
const AT=process.env.AT==='top'?'top':'bottom';
const {app}=require('electron'),fs=require('fs'),os=require('os'),path=require('path'),assert=require('assert/strict');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'terminai-order-ui-'));app.setPath('userData',dir);
const f=['alpha','beta','gamma'].map(n=>{const p=path.join(dir,n);fs.mkdirSync(p);return p});
const tab=(cwd,title)=>({cwd,title,customTitle:title,notes:'',focusedMs:0});
fs.writeFileSync(path.join(dir,'prefs.json'),JSON.stringify({seenWelcome:true,groupByFolder:true,railRecent:false,newTabsAt:AT,newTabAgent:'none',voice:{enabled:false},railWidth:300,tabs:[tab(f[0],'a-one'),tab(f[1],'b-one'),tab(f[2],'c-one'),tab(f[2],'c-two')]}));
const delay=ms=>new Promise(r=>setTimeout(r,ms));
app.on('browser-window-created',(_e,win)=>win.webContents.once('did-finish-load',()=>{void(async()=>{
 const js=c=>win.webContents.executeJavaScript(c);
 const heads=()=>js(`Array.from(document.querySelectorAll('.rail .rail-group-head')).map(e=>e.textContent)`);
 const rows=()=>js(`Array.from(document.querySelectorAll('.rail .tab-title')).map(e=>e.textContent)`);
 for(let i=0;i<60&&(await rows()).length<4;i++)await delay(150);
 const before=await heads();
 assert.equal(before.length,3,String(before));
 await js(`Array.from(document.querySelectorAll('.rail .tab')).find(t=>t.textContent.includes('c-two')).dispatchEvent(new MouseEvent('mousedown',{bubbles:true}))`);
 await js(`Array.from(document.querySelectorAll('.rail .tab')).find(t=>t.textContent.includes('c-two')).click()`);await delay(400);
 await js(`document.querySelector('.rail .btn.primary').click()`);
 for(let i=0;i<60&&(await rows()).length<5;i++)await delay(150);
 const after=await rows();
 assert.equal(after.length,5,String(after));
 assert.deepEqual(await heads(),before,'folders stay where they are');
 assert.deepEqual(after.slice(0,2),['a-one','b-one'],String(after));
 if(AT==='top')assert.deepEqual(after.slice(3),['c-one','c-two'],'the new chat is at the top of its folder: '+after);
 else assert.deepEqual(after.slice(2,4),['c-one','c-two'],'the new chat is at the bottom of its folder: '+after);
 console.log(`PASS new tab (${AT}): folders keep their order, the new chat goes at the ${AT} of its own folder`);
 app.quit();
})().catch(e=>{console.error(e);app.exit(1)})}));
setTimeout(()=>{console.error('timeout');app.exit(1)},60000).unref();require('../out/main/index.js');
