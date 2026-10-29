const {app,ipcMain}=require('electron'),fs=require('fs'),os=require('os'),path=require('path'),assert=require('assert/strict');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'terminai-team-ui-'));app.setPath('userData',dir);fs.writeFileSync(path.join(dir,'prefs.json'),JSON.stringify({seenWelcome:true,tabs:[],voice:{enabled:false}}));
const delay=ms=>new Promise(r=>setTimeout(r,ms));const handlers=new Map();const original=ipcMain.handle.bind(ipcMain);ipcMain.handle=(name,fn)=>{handlers.set(name,fn);original(name,fn)};
app.on('browser-window-created',(_e,win)=>win.webContents.once('did-finish-load',()=>{void(async()=>{
await delay(1000);win.setSize(1400,850);let loginFails=true,setupCalls=0;const writes=[];
for(const channel of ['workspace:state','workspace:login','workspace:request','workspace:setup-tools','pty:write','prefs:get']){
 const handler=handlers.get(channel);if(handler)await assert.rejects(async()=>handler({sender:{},senderFrame:{}},{}),/Untrusted/);
}
const identity={user:{id:'owner',name:'Test user',email:'test@example.invalid'},companies:[{id:'one',name:'First',role:'member',classification:'developer',allowCompanySharing:true,defaultVisibility:'owner'},{id:'two',name:'Second',role:'viewer',classification:'viewer',allowCompanySharing:false,defaultVisibility:'owner'}]};
const mock=(name,fn)=>{ipcMain.removeHandler(name);original(name,fn)};
mock('workspace:state',()=>({url:'https://manager.test',signedIn:false}));
mock('workspace:login',()=>{if(loginFails)throw new Error('Invalid credentials');return {url:'https://manager.test',signedIn:true,identity}});
mock('workspace:setup-tools',()=>{setupCalls++;return [{id:'chrome-devtools',status:'configured',message:'Mock assigned tool'}]});
mock('workspace:logout',()=>{throw new Error('Network unavailable')});
mock('workspace:request',(_e,p,m,body)=>{if(m==='POST'){writes.push(body);return {}}return p.endsWith('/messages')?[{id:'m',kind:'user',content:'<script>window.executed=true</script>\nrm -rf example',authorName:'Teammate'}]:[{id:'thread',title:'Team test',ownerId:'owner',visibility:'company'}]});
const js=code=>win.webContents.executeJavaScript(code);
await js(`Array.from(document.querySelectorAll('.topbar button')).find(b=>b.getAttribute('aria-label')==='Browser').click()`);await delay(250);await js(`document.querySelector('[aria-label="New browser tab"]').click()`);await delay(200);assert.equal(win.contentView.children[0].getVisible(),true);
await js(`Array.from(document.querySelectorAll('.topbar button')).find(b=>b.getAttribute('aria-label')==='Sync').click()`);await delay(250);assert.equal(win.contentView.children[0].getVisible(),false);
await js(`document.querySelector('.team-login').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))`);await delay(200);assert.match(await js(`document.querySelector('[role=alert]').textContent`),/Invalid credentials/);
loginFails=false;await js(`document.querySelector('.team-login').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))`);await delay(350);assert.equal(setupCalls,1);
await js(`document.querySelector('.team-conversation').click()`);await delay(250);
assert.equal(await js(`typeof window.executed`),'undefined');assert.match(await js(`document.querySelector('.team-messages pre').textContent`),/<script>/);assert.equal(writes.length,0);
await js(`const select=document.querySelector('select[aria-label=Company]');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(select,'two');select.dispatchEvent(new Event('change',{bubbles:true}))`);await delay(300);assert.equal(setupCalls,2);assert.equal(await js(`document.querySelectorAll('select[aria-label="Conversation visibility"] option').length`),1);assert.equal(await js(`document.querySelectorAll('.team-messages pre').length`),0);
await js(`Array.from(document.querySelectorAll('.team-account button')).find(b=>b.textContent==='Sign out').click()`);await delay(250);assert.equal(await js(`!!document.querySelector('.team-login')`),true);
fs.writeFileSync('/tmp/terminai-team-login-smoke.png',(await win.capturePage()).toPNG());
console.log('PASS Team UI: untrusted IPC rejected, browser hidden, login error/retry, fresh assignment bycompany, inert messages/no sharing bydefault, restricted visibility, failedlogout clears UI');app.quit();
})().catch(e=>{console.error(e);app.exit(1)})}));
setTimeout(()=>{console.error('Team UI timeout');app.exit(1)},20000).unref();require('../out/main/index.js');
