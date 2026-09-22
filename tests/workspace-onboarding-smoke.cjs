const {app}=require('electron'),fs=require('fs'),os=require('os'),path=require('path'),assert=require('assert/strict');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'terminai-onboarding-'));app.setPath('userData',dir);fs.writeFileSync(path.join(dir,'prefs.json'),JSON.stringify({seenWelcome:false,tabs:[],voice:{enabled:false}}));
const delay=ms=>new Promise(r=>setTimeout(r,ms));
app.on('browser-window-created',(_e,win)=>win.webContents.once('did-finish-load',()=>{void(async()=>{
await delay(1200);const js=s=>win.webContents.executeJavaScript(s);
assert.equal(await js(`Array.from(document.querySelectorAll('button')).some(b=>b.textContent.trim()==='Continue locally')`),true);
await js(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='Sign in to your workspace').click()`);await delay(300);
assert.equal(await js(`!!document.querySelector('.team-login')`),true);
assert.equal(await js(`Array.from(document.querySelectorAll('button')).some(b=>b.textContent.trim()==='Continue locally')`),false);
assert.equal(await js(`document.querySelector('.team-login input[type=url]').value`),'https://terminai-manager-production.up.railway.app');
assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'prefs.json'))).seenWelcome,true);
fs.writeFileSync('/tmp/terminai-onboarding.png',(await win.capturePage()).toPNG());
console.log('PASS first-run: local option, welcome→team without stacked overlays, manager prefilled, welcome completion persisted');app.quit();
})().catch(e=>{console.error(e);app.exit(1)})}));
setTimeout(()=>app.exit(1),15000).unref();require('../out/main/index.js');
