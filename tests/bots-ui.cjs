// Settings › Connections against a local manager: the bots list and the Add a bot popup: chat, files with access, people and product permissions. Screenshots go to
// $TEAM_SHOTS when set. Needs MANAGER_TEST_DATABASE_URL (a throwaway Postgres database).
const fs=require('fs'),os=require('os'),path=require('path'),cp=require('child_process'),assert=require('assert/strict'),net=require('net');
if(!process.versions.electron){
 const port=40000+Math.floor(Math.random()*9000),url=`http://127.0.0.1:${port}`;
 const server=cp.spawn(process.execPath,['manager/src/server.js'],{env:{...process.env,PORT:String(port),DATABASE_URL:process.env.MANAGER_TEST_DATABASE_URL,PUBLIC_ORIGIN:url},stdio:['ignore','pipe','inherit']});
 const call=async(p,{token,method='GET',data}={})=>{const r=await fetch(url+p,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},body:data?JSON.stringify(data):undefined});return r.json()};
 (async()=>{
  for(let i=0;i<60;i++){try{await fetch(url+'/health');break}catch{await new Promise(r=>setTimeout(r,250))}}
  const pw='correct horse battery staple 42',tag=Date.now();
  const ilai=await call('/api/auth/signup',{method:'POST',data:{name:'Ilai Bachrach',email:`ilai${tag}@example.test`,companyName:'BUILD',password:pw,client:'desktop'}});
  const company=(await call('/api/me',{token:ilai.token})).companies[0].id;
  const join=async(name,role)=>{const inv=await call(`/api/companies/${company}/invites`,{token:ilai.token,method:'POST',data:{email:`${name.split(' ')[0].toLowerCase()}${tag}@example.test`,role}});return call('/api/auth/accept-invite',{method:'POST',data:{token:inv.token,name,password:pw,client:'desktop'}})};
  const matteo=await join('Matteo Livio','admin'),sofia=await join('Sofia Weber','member');
  const members=(await call(`/api/companies/${company}/members`,{token:ilai.token})).members;
  await call(`/api/companies/${company}/members/${members.find(m=>m.name==='Sofia Weber').id}`,{token:ilai.token,method:'PATCH',data:{products:['mm.org']}});
  await call(`/api/companies/${company}/chat`,{token:matteo.token,method:'POST',data:{body:'Hey, did you see the NDA comments?'}});
  await call(`/api/companies/${company}/chat`,{token:ilai.token,method:'POST',data:{body:'Yes, v2 is in Downloads. Can you review it asap?'}});
  await call(`/api/companies/${company}/chat`,{token:matteo.token,method:'POST',data:{body:'On it, give me 20 minutes.'}});
  const up=async(name,q)=>fetch(`${url}/api/companies/${company}/files?name=${name}&type=application/pdf${q}`,{method:'POST',headers:{Authorization:`Bearer ${ilai.token}`,'Content-Type':'application/octet-stream'},body:Buffer.from('%PDF-1.4 x')});
  await up('NDA%20-%20Sofia%20v2.pdf','&access=admins');await up('Outreach%20sheet.pdf','&access=products&products=mm.org');await up('Brand%20guide.pdf','');
  const env={...process.env,TEAM_URL:url,TEAM_EMAIL:`ilai${tag}@example.test`,TEAM_PW:pw};
  try{cp.execFileSync(path.resolve('node_modules/.bin/electron'),[__filename],{env,stdio:'inherit',timeout:80000})}finally{server.kill()}
 })().catch(e=>{console.error(e);server.kill();process.exit(1)});
}else{
 const {app}=require('electron'),dir=fs.mkdtempSync(path.join(os.tmpdir(),'terminai-bots-'));app.setPath('userData',dir);
 fs.writeFileSync(path.join(dir,'prefs.json'),JSON.stringify({seenWelcome:true,tabs:[],voice:{enabled:false},newTabAgent:'none',chatButton:false}));
 const delay=ms=>new Promise(r=>setTimeout(r,ms)),shots=process.env.TEAM_SHOTS;
 app.on('browser-window-created',(_e,win)=>win.webContents.once('did-finish-load',()=>{void(async()=>{
  await delay(1500);win.setSize(1300,860);const js=s=>win.webContents.executeJavaScript(s);
  const shot=async n=>{if(!shots)return;await delay(900);fs.writeFileSync(path.join(shots,n+'.png'),(await win.webContents.capturePage()).toPNG())};
  await js(`window.term.workspace.login({url:${JSON.stringify(process.env.TEAM_URL)},email:${JSON.stringify(process.env.TEAM_EMAIL)},password:${JSON.stringify(process.env.TEAM_PW)}})`);
  await js(`window.term.teamchat.botSave({name:'Grok Bot',url:'https://api2.cursor.sh/automations/webhook/x',key:'k',header:''})`);
  await js(`document.querySelector('[aria-label="Settings"]').click()`);await delay(500);
  await js(`[...document.querySelectorAll('.team-side nav button')].find(b=>b.textContent==='Connections').click()`);await delay(1200);
  assert.ok(await js(`document.querySelectorAll('.bp-list li').length>=1`),'the bot is listed');
  await shot('bots-1-list');
  await js(`[...document.querySelectorAll('.bp-primary')].find(b=>b.textContent.includes('Add a bot')).click()`);await delay(300);
  await shot('bots-2-name');
  await js(`(()=>{const i=document.querySelector('.bm-field input');const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;set.call(i,'Customer Support Bot');i.dispatchEvent(new Event('input',{bubbles:true}))})()`);await delay(100);
  assert.ok(await js(`document.querySelector('.bl-card.on')?.textContent.includes('Reply only')`),'reply only by default');
  await shot('bots-2b-limits');
  await js(`[...document.querySelectorAll('.bm-foot .bp-primary')][0].click()`);await delay(1200);
  assert.ok(await js(`!!document.querySelector('.bm-key code')`),'the key, shown once');
  await shot('bots-3-setup');
  await js(`[...document.querySelectorAll('.bm-foot .bp-primary')][0].click()`);await delay(300);await shot('bots-4-connect');
  await js(`[...document.querySelectorAll('.bm-foot .bp-ghost')][0].click()`);await delay(200);await js(`document.querySelector('.bm-head .bp-icon').click()`);await delay(600);
  assert.ok(await js(`[...document.querySelectorAll('.bp-list li')].some(l=>l.textContent.includes('Customer Support Bot')&&l.textContent.includes('Setup unfinished'))`),'unfinished bot listed');
  await js(`document.querySelector('.bp-list li:last-child .bp-icon').click()`);await delay(200);await shot('bots-5-menu');
  await js(`[...document.querySelectorAll('.bp-menu button')].find(b=>b.textContent.startsWith('Permissions')).click()`);await delay(600);
  assert.ok(await js(`!!document.querySelector('.bl-cards')`),'permissions popup');await shot('bots-6-permissions');
  console.log('PASS bots ui: list, Add a bot in three steps, key shown once, unfinished bot listed, row menu');app.quit();
 })().catch(e=>{console.error(e);app.exit(1)})}));
 setTimeout(()=>app.exit(1),70000).unref();require('../out/main/index.js');
}
