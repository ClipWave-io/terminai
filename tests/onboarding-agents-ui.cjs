// Onboarding › Your AI agents: after the permissions step, Claude Code and Codex with what this Mac has; Claude ticked when missing.
const {app}=require('electron'),fs=require('fs'),os=require('os'),path=require('path'),assert=require('assert/strict');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'terminai-onb-agents-'));app.setPath('userData',dir);
fs.writeFileSync(path.join(dir,'prefs.json'),JSON.stringify({seenWelcome:false,tabs:[],voice:{enabled:false},newTabAgent:'none'}));
const delay=ms=>new Promise(r=>setTimeout(r,ms)),shots=process.env.SHOTS;
app.on('browser-window-created',(_e,win)=>win.webContents.once('did-finish-load',()=>{void(async()=>{
  await delay(1500);win.setSize(1200,800);const js=s=>win.webContents.executeJavaScript(s);
  const click=t=>js(`[...document.querySelectorAll('.onb button')].find(b=>b.textContent.trim()===${JSON.stringify(t)})?.click()`);
  await click('Get started');await delay(400);await click('Continue');await delay(800);
  assert.match(await js(`document.querySelector('.onb-card h1')?.textContent||''`),/Your AI agents/);
  assert.equal(await js(`document.querySelectorAll('.onb-agent').length`),3,'Claude Code, Claude in Chrome and Codex');
  const status=await js(`window.term.agents.status()`);
  assert.equal(await js(`document.querySelectorAll('.onb-agent input')[0].checked`),true,'Claude Code ticked (or already installed)');
  if(shots)fs.writeFileSync(path.join(shots,'onboarding-agents.png'),(await win.webContents.capturePage()).toPNG());
  console.log(`PASS onboarding agents step: this Mac has claude=${status.claude} codex=${status.codex}`);app.quit();
 })().catch(e=>{console.error(e);app.exit(1)})}));
setTimeout(()=>app.exit(1),40000).unref();require('../out/main/index.js');
