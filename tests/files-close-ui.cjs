// Files full size (a PDF open large), then Files closed: clicking a chat shows the code pane again.
const {app}=require('electron'),fs=require('fs'),os=require('os'),path=require('path'),assert=require('assert/strict');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'terminai-filesclose-'));app.setPath('userData',dir);
fs.writeFileSync(path.join(dir,'prefs.json'),JSON.stringify({seenWelcome:true,voice:{enabled:false},newTabAgent:'none',tabs:[{cwd:os.homedir(),title:'a',customTitle:'One',notes:'',focusedMs:0},{cwd:os.homedir(),title:'b',customTitle:'Two',notes:'',focusedMs:0}]}));
const delay=ms=>new Promise(r=>setTimeout(r,ms));
app.on('browser-window-created',(_e,win)=>win.webContents.once('did-finish-load',()=>{void(async()=>{try{
  await delay(2200);win.setSize(1300,820);const js=s=>win.webContents.executeJavaScript(s);
  const codeShown=()=>js(`!document.querySelector('.pane').classList.contains('workspace-hidden')`);
  assert.ok(await codeShown(),'code pane at start');
  await js(`document.querySelector('[aria-label="Files"]').click()`);await delay(500);
  await js(`document.querySelector('[aria-label="Full size"]').click()`);await delay(300);
  assert.ok(!(await codeShown()),'full size hides the code');
  await js(`document.querySelector('[aria-label="Close files"]').click()`);await delay(300);
  assert.ok(await codeShown(),'closing Files brings the code back');
  // Again, but come back by clicking a chat after hiding Files from the toolbar.
  await js(`document.querySelector('[aria-label="Files"]').click()`);await delay(400);
  await js(`document.querySelector('[aria-label="Full size"]').click()`);await delay(300);
  await js(`[...document.querySelectorAll('.rail .tab')].find(t=>t.textContent.includes('Two')).dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0}))`);await delay(400);
  assert.ok(await codeShown(),'clicking a chat shows its code');
  console.log('PASS files close: the code pane comes back after Files full size');app.exit(0)
}catch(e){console.error(e);app.exit(1)}})()}));
require(path.join(__dirname,'../out/main/index.js'));
