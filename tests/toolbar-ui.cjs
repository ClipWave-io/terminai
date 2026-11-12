// Top bar: any icon moves to either side (⋯ panel, or dragging it onto the other side), the chat is its own
// round button bottom right (off in Settings), feedback opens from the bottom of Settings, and the sidebar can sort
// conversations by last activity with the time under each.
const {app}=require('electron'),fs=require('fs'),os=require('os'),path=require('path'),assert=require('assert/strict');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'terminai-toolbar-'));app.setPath('userData',dir);
fs.writeFileSync(path.join(dir,'prefs.json'),JSON.stringify({seenWelcome:true,voice:{enabled:false},newTabAgent:'none',groupByFolder:false,railRecent:true,railTimes:true,
  tabs:[{cwd:os.homedir(),title:'z',customTitle:'Sleepy',agent:'claude',claude:true,claudeSession:'00000000-0000-4000-8000-000000000000',notes:'',focusedMs:0,activityAt:Date.now()-2*86400000},{cwd:os.homedir(),title:'a',customTitle:'Old one',notes:'',focusedMs:0,activityAt:Date.now()-3*86400000},{cwd:os.homedir(),title:'b',customTitle:'New one',notes:'',focusedMs:0,activityAt:Date.now()-5*60000-5000}]}));
const delay=ms=>new Promise(r=>setTimeout(r,ms)),shots=process.env.SHOTS;
app.on('browser-window-created',(_e,win)=>win.webContents.once('did-finish-load',()=>{void(async()=>{
  await delay(1800);win.setSize(1300,820);const js=s=>win.webContents.executeJavaScript(s);
  const side=label=>js(`document.querySelector('[aria-label="${label}"]')?.closest('.topbar-side')?.classList.contains('right')`);
  assert.equal(await side('Sync'),false);assert.equal(await side('To-do'),true);
  assert.equal(await js(`!!document.querySelector('.topbar [aria-label^="Team chat"]')`),true,'chat in the toolbar');
  assert.ok(await js(`!!document.querySelector('.corner-chat')`),'chat button bottom right');
  // Drag the chat button to the top left, shrink it, put it back.
  await js(`(()=>{const b=document.querySelector('.cb'),r=b.getBoundingClientRect();b.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,button:0,clientX:r.left+5,clientY:r.top+5}));for(const [x,y] of [[r.left-20,r.top-20],[300,200],[200,150]])window.dispatchEvent(new MouseEvent('mousemove',{clientX:x,clientY:y}));window.dispatchEvent(new MouseEvent('mouseup',{}))})()`);await delay(300);
  assert.ok(await js(`document.querySelector('.cb').classList.contains('moved')&&document.querySelector('.cb').getBoundingClientRect().top<200`),'chat button moved anywhere');
  await js(`document.querySelector('[aria-label="Smaller chat button"]').click()`);await delay(200);
  assert.ok(await js(`document.querySelector('.corner-chat').classList.contains('mini')`),'small round chat button');
  if(shots)fs.writeFileSync(path.join(shots,'chat-button-moved.png'),(await win.webContents.capturePage()).toPNG());
  await js(`document.querySelector('[aria-label="Bigger chat button"]').click()`);await js(`document.querySelector('[aria-label="Put the chat button back"]').click()`);await delay(300);
  assert.ok(await js(`!document.querySelector('.cb').classList.contains('moved')`),'back in its place');
  await js(`document.querySelector('[aria-label="Customize toolbar"]').click()`);await delay(300);
  await js(`[...document.querySelectorAll('.tb-item')].find(r=>r.textContent.startsWith('Sync')).querySelector('.tb-seg button:last-child').click()`);await delay(400);
  assert.equal(await side('Sync'),true,'moved right from the panel');
  if(shots)fs.writeFileSync(path.join(shots,'toolbar-panel.png'),(await win.webContents.capturePage()).toPNG());
  await js(`document.querySelector('.toolbar-customize-backdrop').click()`);await delay(300);
  // Drag To-do onto the left side.
  await js(`(()=>{const dt=new DataTransfer();const src=document.querySelector('[aria-label="To-do"]');src.dispatchEvent(new DragEvent('dragstart',{bubbles:true,dataTransfer:dt}));const left=document.querySelector('.topbar-side.left');left.dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer:dt}));left.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:dt}))})()`);await delay(400);
  assert.equal(await side('To-do'),false,'dragged to the left');
  const prefs=JSON.parse(fs.readFileSync(path.join(dir,'prefs.json'),'utf8'));assert.ok(prefs.toolbarRight.includes('team')&&!prefs.toolbarRight.includes('todo'),'saved');
    for(let i=0;i<20&&await js(`document.querySelectorAll('.rail .tab').length`)<3;i++)await delay(250);
  assert.deepEqual(await js(`[...document.querySelectorAll('.rail .tab-title')].map(t=>t.textContent)`),['New one','Sleepy','Old one'],'newest first');
  assert.ok(await js(`[...document.querySelectorAll('.rail .tab')].find(t=>t.textContent.includes('Sleepy')).classList.contains('is-asleep')&&!!document.querySelector('.tab-dot.asleep')`),'the conversation not running shows as asleep');
  assert.equal(await js(`document.querySelectorAll('.rail .tab.is-asleep').length`),1,'only that one');
  // A new conversation starts at the top.
  const before=await js(`document.querySelectorAll('.rail .tab').length`);
  await js(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='+ New tab').click()`);
  for(let i=0;i<20&&await js(`document.querySelectorAll('.rail .tab').length`)===before;i++)await delay(200);
  assert.ok(await js(`document.querySelector('.rail .tab').classList.contains('active')`),'the new tab is the first row');
  if(shots)fs.writeFileSync(path.join(shots,'asleep.png'),(await win.webContents.capturePage()).toPNG());
  assert.ok(await js(`[...document.querySelectorAll('.rail .tab-ago')].some(t=>t.textContent==='5 min ago')`),'time under it');
  assert.equal(await js(`!!document.querySelector('.rail [aria-label="Send feedback"]')`),false,'no feedback in the sidebar');
  await js(`document.querySelector('[aria-label="Settings"]').click()`);await delay(500);
  await js(`document.querySelector('.team-side [aria-label="Send feedback"]').click()`);await delay(300);
  assert.ok(await js(`!!document.querySelector('.fb-panel textarea')`),'feedback panel');
  if(shots)fs.writeFileSync(path.join(shots,'toolbar-feedback.png'),(await win.webContents.capturePage()).toPNG());
  // Settings › Notifications › Sounds: a switch per kind; turning one off is saved.
  await js(`document.querySelector('.fb-panel')&&document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);await delay(200);
  await js(`[...document.querySelectorAll('.team-side button')].find(b=>b.textContent.trim()==='Notifications').click()`);await delay(400);
  assert.equal(await js(`document.querySelectorAll('.st-sound').length`),8,'eight sound kinds');
  await js(`document.querySelectorAll('.st-sound')[2].querySelector('[role="switch"],button:last-child,input').click()`);await delay(500);
  assert.equal(await js(`window.term.prefs.get().then(p=>p.sounds.done)`),false,'A conversation is done: sound off');
  if(shots){win.show();win.webContents.invalidate();await delay(800);fs.writeFileSync(path.join(shots,'settings-sounds.png'),(await win.webContents.capturePage()).toPNG())}
  console.log('PASS toolbar: icons move to either side by panel and drag, chat button bottom right, feedback at the bottom of Settings, sidebar sorted by last activity with times');app.quit();
 })().catch(e=>{console.error(e);app.exit(1)})}));
setTimeout(()=>app.exit(1),40000).unref();require('../out/main/index.js');
