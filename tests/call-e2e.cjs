// Calls end to end: two TerminAI apps signed in as two people against a local manager, with Chromium's fake camera and
// microphone. Ilai rings Matteo with video, Matteo answers, both get the other's picture and sound directly (WebRTC),
// mute shows on the other side, hang up ends it on both. Screenshots go to $CALL_SHOTS when set.
// Needs MANAGER_TEST_DATABASE_URL (a throwaway Postgres database).
const fs=require('fs'),os=require('os'),path=require('path'),cp=require('child_process'),assert=require('assert/strict');
if(!process.versions.electron){
 const port=40000+Math.floor(Math.random()*9000),url=`http://127.0.0.1:${port}`;
 const server=cp.spawn(process.execPath,['manager/src/server.js'],{env:{...process.env,PORT:String(port),DATABASE_URL:process.env.MANAGER_TEST_DATABASE_URL,PUBLIC_ORIGIN:url},stdio:['ignore','pipe','inherit']});
 const call=async(p,{token,method='GET',data}={})=>{const r=await fetch(url+p,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},body:data?JSON.stringify(data):undefined});return r.json()};
 (async()=>{
  for(let i=0;i<60;i++){try{await fetch(url+'/health');break}catch{await new Promise(r=>setTimeout(r,250))}}
  const pw='correct horse battery staple 42',tag=Date.now();
  const ilai=await call('/api/auth/signup',{method:'POST',data:{name:'Ilai Bachrach',email:`ilai${tag}@example.test`,companyName:'CALL',password:pw,client:'desktop'}});
  const company=(await call('/api/me',{token:ilai.token})).companies[0].id;
  const inv=await call(`/api/companies/${company}/invites`,{token:ilai.token,method:'POST',data:{email:`matteo${tag}@example.test`,role:'admin'}});
  await call('/api/auth/accept-invite',{method:'POST',data:{token:inv.token,name:'Matteo Livio',password:pw,client:'desktop'}});
  // The ICE servers route answers (STUN at least).
  const ice=await call(`/api/companies/${company}/call/ice`,{token:ilai.token});assert.ok(ice.iceServers?.length,'ice servers');
  const run=role=>new Promise((res,rej)=>{const p=cp.spawn(path.resolve('node_modules/.bin/electron'),[__filename],{env:{...process.env,ROLE:role,TEAM_URL:url,TEAM_EMAIL:`${role==='caller'?'ilai':'matteo'}${tag}@example.test`,TEAM_PW:pw},stdio:'inherit'});
   const t=setTimeout(()=>{p.kill();rej(new Error(role+' timed out'))},110000);p.on('exit',c=>{clearTimeout(t);c===0?res():rej(new Error(`${role} exited ${c}`))})});
  try{await Promise.all([run('caller'),run('callee')]);console.log('PASS calls: ring, answer with video, picture and sound both ways, mute shown, hang up on both; both calling at once makes one call; minimize and restore')}
  finally{server.kill()}
 })().catch(e=>{console.error(e);server.kill();process.exit(1)});
}else{
 const {app}=require('electron'),role=process.env.ROLE,dir=fs.mkdtempSync(path.join(os.tmpdir(),`terminai-call-${role}-`));app.setPath('userData',dir);
 app.commandLine.appendSwitch('use-fake-device-for-media-stream');app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
 fs.writeFileSync(path.join(dir,'prefs.json'),JSON.stringify({seenWelcome:true,tabs:[],voice:{enabled:false},newTabAgent:'none'}));
 const delay=ms=>new Promise(r=>setTimeout(r,ms)),shots=process.env.CALL_SHOTS;
 app.on('browser-window-created',(_e,win)=>win.webContents.once('did-finish-load',()=>{void(async()=>{
  await delay(1500);win.setSize(1200,800);const js=s=>win.webContents.executeJavaScript(s);
  const until=async(cond,what,ms=40000)=>{for(const end=Date.now()+ms;Date.now()<end;await delay(250))if(await js(cond))return;throw new Error(`${role}: ${what}`)};
  const shot=async n=>{if(!shots)return;await delay(400);fs.writeFileSync(path.join(shots,`${role}-${n}.png`),(await win.webContents.capturePage()).toPNG())};
  await js(`window.term.workspace.login({url:${JSON.stringify(process.env.TEAM_URL)},email:${JSON.stringify(process.env.TEAM_EMAIL)},password:${JSON.stringify(process.env.TEAM_PW)}})`);
  await js(`document.querySelector('[aria-label^="Team chat"]').click()`);
  const remoteOk=`(()=>{const v=document.querySelector('.call-remote');return !!v&&v.videoWidth>0&&v.currentTime>0})()`;
  // Sound really plays: the player runs (not paused, time moving) on a live audio track.
  const soundOk=`[...document.querySelectorAll('.call audio')].some(a=>!a.paused&&a.currentTime>0.5&&a.srcObject&&a.srcObject.getAudioTracks().some(t=>t.readyState==='live'&&!t.muted))`;
  // Both press call at the same moment (at the next whole 4 s on the clock): one call connects, nobody hears "busy".
  const bothCall=async()=>{await delay(4000-Date.now()%4000+500);await js(`document.querySelector('.tc-calls [aria-label="Voice call"]').click()`);
   await until(`document.querySelector('.call')?.dataset.state==='live'`,'both calling: connected');
   assert.ok(!/another call|declined/.test(await js(`document.body.innerText`)),'no busy');await until(soundOk,'sound in the merged call')};
  if(role==='caller'){
   await until(`!!document.querySelector('.tc-calls [aria-label="Video call"]')`,'call button');
   await delay(1500);// the callee's signal poll is running by now
   await js(`document.querySelector('.tc-calls [aria-label="Video call"]').click()`);
   await until(`document.querySelector('.call')?.dataset.state==='outgoing'`,'ringing');await shot('1-ringing');
   await until(`document.querySelector('.call')?.dataset.state==='live'`,'connected');
   await until(remoteOk,'remote picture');await until(soundOk,'remote sound');await shot('3-live');
   await delay(1500);await js(`document.querySelector('.call [aria-label="Mute"]').click()`);
   await delay(6000);await js(`document.querySelector('.call [aria-label="Hang up"]').click()`);
   await until(`!document.querySelector('.call.card')`,'ended here');
   await bothCall();
   await js(`document.querySelector('.call [aria-label="Minimize"]').click()`);await until(`!!document.querySelector('.call.mini')`,'minimized');await shot('5-mini');
   await js(`document.querySelector('.call [aria-label="Show the call"]').click()`);await until(`!document.querySelector('.call.mini')&&!!document.querySelector('.call-top')`,'shown again');
   await delay(1000);await js(`document.querySelector('.call [aria-label="Hang up"]').click()`);await until(`!document.querySelector('.call.card')`,'second call ended');
  }else{
   await until(`document.querySelector('.call')?.dataset.state==='incoming'`,'incoming call',60000);await shot('2-incoming');
   assert.match(await js(`document.querySelector('.call').textContent`),/Ilai Bachrach.*Video call/);
   await js(`document.querySelector('.call [aria-label="Answer with video"]').click()`);
   await until(`document.querySelector('.call')?.dataset.state==='live'`,'connected');
   await until(remoteOk,'remote picture');await until(soundOk,'remote sound');
   await until(`/muted/.test(document.querySelector('.call-who.slim small')?.textContent||'')`,'mute shown');await shot('4-muted');
   await until(`!document.querySelector('.call.card')`,'ended by the other side');
   await bothCall();
   await until(`!document.querySelector('.call.card')`,'second call ended by the other side');
  }
  console.log(`ok ${role}`);app.quit();
 })().catch(e=>{console.error(e);app.exit(1)})}));
 setTimeout(()=>app.exit(1),100000).unref();require('../out/main/index.js');
}
