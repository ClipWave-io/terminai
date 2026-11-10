// Team drawer against a local manager: chat, files with access, people and product permissions. Screenshots go to
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
  await call(`/api/companies/${company}/chat`,{token:sofia.token});// Sofia's app fetched them too: delivered to everyone
  const up=async(name,q)=>fetch(`${url}/api/companies/${company}/files?name=${name}&type=application/pdf${q}`,{method:'POST',headers:{Authorization:`Bearer ${ilai.token}`,'Content-Type':'application/octet-stream'},body:Buffer.from('%PDF-1.4 x')});
  await up('NDA%20-%20Sofia%20v2.pdf','&access=admins');await up('Outreach%20sheet.pdf','&access=products&products=mm.org');await up('Brand%20guide.pdf','');
  const env={...process.env,TEAM_URL:url,TEAM_EMAIL:`ilai${tag}@example.test`,TEAM_PW:pw};
  try{cp.execFileSync(path.resolve('node_modules/.bin/electron'),[__filename],{env,stdio:'inherit',timeout:80000})}finally{server.kill()}
 })().catch(e=>{console.error(e);server.kill();process.exit(1)});
}else{
 const {app}=require('electron'),dir=fs.mkdtempSync(path.join(os.tmpdir(),'terminai-team-drawer-'));app.setPath('userData',dir);
 fs.writeFileSync(path.join(dir,'prefs.json'),JSON.stringify({seenWelcome:true,tabs:[],voice:{enabled:false},newTabAgent:'none'}));
 const delay=ms=>new Promise(r=>setTimeout(r,ms)),shots=process.env.TEAM_SHOTS;
 app.on('browser-window-created',(_e,win)=>win.webContents.once('did-finish-load',()=>{void(async()=>{
  await delay(1500);win.setSize(1300,860);const js=s=>win.webContents.executeJavaScript(s);
  const shot=async n=>{if(!shots)return;await delay(500);fs.writeFileSync(path.join(shots,n+'.png'),(await win.webContents.capturePage()).toPNG())};
  await js(`window.term.workspace.login({url:${JSON.stringify(process.env.TEAM_URL)},email:${JSON.stringify(process.env.TEAM_EMAIL)},password:${JSON.stringify(process.env.TEAM_PW)}})`);
  await js(`document.querySelector('[aria-label^="Team chat"]').click()`);
  for(let i=0;i<40&&!await js(`document.querySelectorAll('.tc-msg').length>=3`);i++)await delay(250);
  assert.equal(await js(`document.querySelectorAll('.tc-msg').length`),3,'three messages');
  assert.ok(await js(`document.querySelectorAll('.tc-faces .pp-avatar').length>=2`),'faces of the team in the header');
  // Ilai's message: Matteo wrote after it, so his app has it: two grey ticks (not read yet: not blue).
  assert.ok(await js(`[...document.querySelectorAll('.tc-msg.mine')].some(m=>m.querySelector('.tc-ticks:not(.read) svg path')?.getAttribute('d').startsWith('M2 12.5'))`),'two grey ticks once it is on their Mac');
  await shot('1-chat');
  await js(`[...document.querySelectorAll('.tc-tabs button')].find(b=>b.textContent==='Files').click()`);
  for(let i=0;i<30&&!await js(`document.querySelectorAll('.tc-frow').length===3`);i++)await delay(200);
  assert.equal(await js(`document.querySelectorAll('.tc-frow').length`),3);
  await js(`document.querySelector('.tc-access-btn').click()`);await delay(200);
  await js(`[...document.querySelectorAll('.tc-access-pop .pp-seg button')].find(b=>b.textContent==='Products').click()`);await delay(300);
  await shot('2-files');
  await js(`[...document.querySelectorAll('.tc-tabs button')].find(b=>b.textContent==='People').click()`);
  for(let i=0;i<30&&!await js(`document.querySelectorAll('.pp-list li').length===3`);i++)await delay(200);
  assert.equal(await js(`document.querySelectorAll('.pp-list li').length`),3,'three people');
  await js(`[...document.querySelectorAll('.pp-scope')].find(b=>!b.disabled).click()`);await delay(300);
  assert.ok(await js(`[...document.querySelectorAll('.pp-chip.on')].some(b=>b.textContent==='mm.org')`),'Sofia limited to mm.org, shown as a chip');
  await shot('3-people');
  console.log('PASS team drawer: chat with faces, files with access chips, people with product chips');app.quit();
 })().catch(e=>{console.error(e);app.exit(1)})}));
 setTimeout(()=>app.exit(1),70000).unref();require('../out/main/index.js');
}
