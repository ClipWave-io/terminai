// TerminAI Browser end to end: the puzzle button downloads the pinned Chromium (checksum verified), installs it in
// userData, starts it on its DevTools port with the Claude native hosts in its profile, and docks it beside the window.
// Run: npm run build && TERMINAI_TEST_BUILD=1 npx electron tests/terminai-browser-ui.cjs   (downloads ~160 MB)
const {app}=require('electron'),fs=require('fs'),os=require('os'),path=require('path'),assert=require('assert/strict'),cp=require('child_process');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'terminai-chromium-'));app.setPath('userData',dir);process.env.CODEX_HOME=path.join(dir,'codex');
fs.writeFileSync(path.join(dir,'prefs.json'),JSON.stringify({seenWelcome:true,browserBeta:true,tabs:[],voice:{enabled:false}}));
const delay=ms=>new Promise(r=>setTimeout(r,ms)),port=9347;
const json=async p=>(await fetch(`http://127.0.0.1:${port}${p}`)).json();
app.on('browser-window-created',(_e,win)=>win.webContents.once('did-finish-load',()=>{void(async()=>{
 await delay(1500);win.setBounds({x:40,y:40,width:1400,height:860});
 const js=s=>win.webContents.executeJavaScript(s).catch(e=>{console.error("Failed renderer check:",s.slice(0,120));throw e});
 for(let i=0;i<100&&!await js(`!!document.querySelector('[aria-label="Browser"]')`);i++)await delay(200);fs.writeFileSync('/tmp/tb-start.png',(await win.capturePage()).toPNG());console.log('tabs:',await js(`[...document.querySelectorAll('.workspace-tabs button')].map(b=>b.getAttribute('aria-label')).join(',')`));
 await js(`document.querySelector('[aria-label="Browser"]').click()`);await delay(400);
 assert.equal(await js(`!!document.querySelector('[aria-label="Open in TerminAI Browser"]')`),true,'Puzzle button in the browser sidebar');
 // The button opens the current page; with none, a new window. Progress shows in the status line while it downloads.
 await js(`window.__ev=[];window.term.browser.onFullStatus(s=>window.__ev.push(s.state+':'+(s.progress??'')));0`);await js(`window.__open=window.term.browser.openFull('https://example.com/').then(s=>window.__done=s,e=>window.__err=String(e))`);
 let sawProgress=false;
 for(let i=0;i<1200&&!await js(`!!(window.__done||window.__err)`);i++){if(/Downloading TerminAI Browser/.test(await js(`document.querySelector('.browser-status')?.textContent||''`)))sawProgress=true;await delay(500)}
 assert.equal(await js(`window.__err||null`),null);
 assert.equal(await js(`window.__done.state`),'running');console.log('events',await js('window.__ev.slice(0,5).join(" ")+" … "+window.__ev.length'));const ev=await js('window.__ev');assert.ok(ev.filter(e=>e.startsWith('downloading:')).length>=10&&ev.some(e=>e.startsWith('running:')),'Download progress reported to the window');
 const root=path.join(dir,'TerminAI Browser');
 assert.equal(JSON.parse(fs.readFileSync(path.join(root,'installed.json'),'utf8')).version,'159.0.8154.0');
 const sig=cp.spawnSync('/usr/bin/codesign',['-dvv',path.join(root,'TerminAI Browser.app')],{encoding:'utf8'}).stderr;
 const v=await json('/json/version');assert.match(v.Browser,/^Chrome\/159\./);
 assert.ok((await json('/json/list')).some(t=>t.type==='page'&&t.url==='https://example.com/'),'The link opened');
 const hosts=fs.readdirSync(path.join(root,'Profile','NativeMessagingHosts'));
 if(fs.existsSync(path.join(os.homedir(),'.claude/chrome/chrome-native-host')))assert.ok(hosts.includes('com.anthropic.claude_code_browser_extension.json'),'Claude Code native host');
 // Docked: the browser window takes the right half of the TerminAI window.
 const page=(await json('/json/list')).find(t=>t.type==='page');const ws=new WebSocket(page.webSocketDebuggerUrl);await new Promise(r=>ws.onopen=r);
 const bounds=await new Promise(r=>{ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id===1)ws.send(JSON.stringify({id:2,method:'Browser.getWindowBounds',params:{windowId:m.result.windowId}}));if(m.id===2)r(m.result.bounds)};ws.send(JSON.stringify({id:1,method:'Browser.getWindowForTarget',params:{}}))});
 ws.close();const b=win.getBounds();assert.ok(Math.abs(bounds.left-(b.x+b.width/2))<40&&Math.abs(bounds.top-b.y)<40,`Docked right of TerminAI (${JSON.stringify(bounds)} vs ${JSON.stringify(b)})`);
 // A second open reuses the running browser: a new tab, no second process.
 await js(`window.term.browser.openFull('https://example.org/')`);await delay(1500);
 assert.ok((await json('/json/list')).some(t=>t.url==='https://example.org/'),'Second link in the same browser');
 assert.equal((await js(`window.term.browser.fullStatus()`)).state,'running');
 // The terminai command, as an agent in a tab uses it.
 const cli=a=>new Promise((resolve,reject)=>cp.execFile(process.execPath,[path.join(__dirname,'../resources/terminai.cjs'),...a],{env:{...process.env,ELECTRON_RUN_AS_NODE:'1',TERMINAI_CONTROL:path.join(dir,'control.json')}},(e,out)=>e?reject(e):resolve(JSON.parse(out))));
 assert.equal((await cli(['browser','status'])).state,'running');
 assert.equal((await cli(['browser','open','https://example.net/'])).state,'running');await delay(1000);
 assert.ok((await json('/json/list')).some(t=>t.url==='https://example.net/'),'terminai browser open <url>');
 await assert.rejects(cli(['browser','open','file:///etc/passwd']));
 fs.writeFileSync('/tmp/terminai-browser-docked.png',(await win.capturePage()).toPNG());
 assert.match(sig,/Authority=Developer ID Application: Ilai Bachrach \(99PQ34696X\)/);console.log('PASS download+checksum, Developer ID signed app, DevTools on 127.0.0.1:'+port+', Claude native host, docked, reuse, terminai browser CLI');
 cp.execFileSync('/usr/bin/pkill',['-f',path.join(root,'Profile')]);app.quit();
})().catch(e=>{console.error(e);try{cp.execFileSync('/usr/bin/pkill',['-f',path.join(dir,'TerminAI Browser','Profile')])}catch{}app.exit(1)})}));
setTimeout(()=>app.exit(1),15*60_000).unref();require('../out/main/index.js');
