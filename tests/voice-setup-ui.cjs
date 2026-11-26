// Onboarding › Talk instead of typing and Settings › Voice: "Set up voice dictation" end to end, into a test folder.
// Downloads the real LocalFlow release, checks it is installed and signed, then shows each permission card and
// "Ready: hold fn and talk". Never touches /Applications/LocalFlow.app or ~/.config/localflow: the app goes to a temp
// folder, LocalFlow's data to a temp home (TerminAI does not start it or change the fn setting in this mode), and the
// model is looked up in HF_HOME (the real cache, read only; set HF_HOME to an empty folder to test the 2.5 GB download).
// After `npx electron-vite build`:  TERMINAI_TEST_BUILD=1 SHOTS=<dir> npx electron tests/voice-setup-ui.cjs
const {app}=require('electron'),fs=require('fs'),os=require('os'),path=require('path'),assert=require('assert/strict'),{execFileSync}=require('child_process');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'terminai-voice-'));app.setPath('userData',dir);
const apps=path.join(dir,'Applications'),home=path.join(dir,'home'),data=path.join(home,'.local/share/localflow');
fs.mkdirSync(apps,{recursive:true});fs.mkdirSync(data,{recursive:true});
process.env.TERMINAI_LOCALFLOW_APPS=apps;process.env.TERMINAI_LOCALFLOW_HOME=home;process.env.HF_HOME??=path.join(os.homedir(),'.cache/huggingface');
fs.writeFileSync(path.join(dir,'prefs.json'),JSON.stringify({seenWelcome:false,tabs:[],voice:{enabled:false},newTabAgent:'none'}));
const delay=ms=>new Promise(r=>setTimeout(r,ms)),shots=process.env.SHOTS;
app.on('browser-window-created',(_e,win)=>win.webContents.once('did-finish-load',()=>{void(async()=>{
  await delay(1500);win.setSize(1200,860);const js=s=>win.webContents.executeJavaScript(s);
  const shot=async n=>{if(shots)fs.writeFileSync(path.join(shots,n),(await win.webContents.capturePage()).toPNG())};
  const status=()=>js(`window.term.localflow.status()`);
  await js(`document.querySelectorAll('.onb-dots i')[4].click()`);await delay(600);
  assert.match(await js(`document.querySelector('.onb-card h1')?.textContent||''`),/Talk instead of typing/);
  assert.equal((await status()).installed,false,'nothing in the test folder yet');
  await shot('voice-1-offer.png');
  await js(`[...document.querySelectorAll('.onb button')].find(b=>b.textContent.trim()==='Set up voice dictation').click()`);
  let st,t0=Date.now(),sawProgress=false;
  for(;;){st=await status();if(st.phase==='download'&&st.appProgress>0.2&&!sawProgress){sawProgress=true;await delay(700);await shot('voice-2-downloading.png')}
    if(st.installed&&st.phase!=='download'&&st.phase!=='install')break;if(st.phase==='error')throw new Error(st.error);
    if(Date.now()-t0>300000)throw new Error('install took over 5 minutes');await delay(500)}
  assert.ok(sawProgress,'download progress was shown');
  const lf=path.join(apps,'LocalFlow.app');
  execFileSync('/usr/bin/codesign',['--verify','--deep','--strict',lf]);
  execFileSync('/usr/sbin/spctl',['-a','-t','exec',lf]);
  for(let i=0;i<120&&(await status()).phase==='model';i++)await delay(500);
  st=await status();assert.equal(st.modelReady,true,'model found');assert.equal(st.phase,'idle',st.error);
  // What LocalFlow reports once started, before the permissions are given.
  fs.writeFileSync(path.join(data,'permissions.json'),JSON.stringify({microphone:'notDetermined',accessibility:false,pid:1}));
  await delay(1500);await shot('voice-3-permissions.png');
  assert.equal(await js(`[...document.querySelectorAll('.ps-card strong')].map(s=>s.textContent).join(',')`),'LocalFlow,Speech model,Microphone,Accessibility,fn key');
  assert.equal(await js(`[...document.querySelectorAll('.ps-card .ps-btn')].filter(b=>b.textContent==='Open Settings').length`),2);
  // Granted: LocalFlow's own report and log lines (needs a LocalFlow process running on this Mac for "running").
  fs.writeFileSync(path.join(data,'permissions.json'),JSON.stringify({microphone:'authorized',accessibility:true,pid:1}));
  const now=new Date(),p=n=>String(n).padStart(2,'0'),ts=`${now.getFullYear()}-${p(now.getMonth()+1)}-${p(now.getDate())} ${p(now.getHours())}:${p(now.getMinutes())}:${p(now.getSeconds())},000`;
  fs.writeFileSync(path.join(data,'localflow.log'),`${ts} INFO hotkey armed (fn)\n${ts} INFO model ready: parakeet\n`);
  await delay(1500);st=await status();
  if(st.running&&st.fnKey){assert.equal(st.ready,true);assert.match(await js(`document.querySelector('.vs-ready')?.textContent||''`),/Ready: hold fn and talk/)}
  await shot('voice-4-ready.png');
  await js(`[...document.querySelectorAll('.onb button')].find(b=>b.textContent.trim()==='Start using TerminAI').click()`);await delay(800);
  win.webContents.send('settings:open','voice');await delay(1500);
  assert.match(await js(`document.querySelector('.team-main')?.textContent||''`),/Voice dictation/);
  await js(`document.querySelector('.team-main .st-card:last-of-type')?.scrollIntoView()`);await delay(400);
  await shot('voice-5-settings.png');
  console.log(`PASS voice setup: installed and signed in ${Math.round((Date.now()-t0)/1000)}s, ready=${st.ready} (running=${st.running} fnKey=${st.fnKey})`);
  fs.rmSync(dir,{recursive:true,force:true});app.quit();
 })().catch(e=>{console.error(e);app.exit(1)})}));
setTimeout(()=>app.exit(1),420000).unref();require('../out/main/index.js');
