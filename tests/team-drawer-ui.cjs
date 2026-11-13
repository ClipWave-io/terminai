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
  await call(`/api/companies/${company}/chat`,{token:matteo.token,method:'POST',data:{body:'On it, see https://terminai.xyz/download/mac in 20 minutes.'}});
  // Matteo sends a picture in the chat (a 1x1 PNG).
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==','base64');
  const pic=await (await fetch(`${url}/api/companies/${company}/files?name=screen.png&type=image/png&chat=1`,{method:'POST',headers:{Authorization:`Bearer ${matteo.token}`,'Content-Type':'application/octet-stream'},body:png})).json();
  await call(`/api/companies/${company}/chat`,{token:matteo.token,method:'POST',data:{body:'',fileId:pic.file.id}});
  await call(`/api/companies/${company}/chat`,{token:sofia.token});// Sofia's app fetched them too: delivered to everyone
  const up=async(name,q)=>fetch(`${url}/api/companies/${company}/files?name=${name}&type=application/pdf${q}`,{method:'POST',headers:{Authorization:`Bearer ${ilai.token}`,'Content-Type':'application/octet-stream'},body:Buffer.from('%PDF-1.4 x')});
  await up('NDA%20-%20Sofia%20v2.pdf','&access=admins');await up('Outreach%20sheet.pdf','&access=products&products=mm.org');await up('Brand%20guide.pdf','');await up('Warwick%20deck.pdf','&folder=Sales%2FUniversities');
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
  for(let i=0;i<40&&!await js(`document.querySelectorAll('.tc-msg').length>=4`);i++)await delay(250);
  assert.equal(await js(`document.querySelectorAll('.tc-msg').length`),4,'three messages and a picture');
  assert.ok(await js(`document.querySelectorAll('.tc-faces .pp-avatar').length>=1`),'faces of the people in this chat (Sofia, limited to mm.org, is not in the team chat)');
  // Ilai's message: Matteo wrote after it, so his app has it: two grey ticks (not read yet: not blue).
  assert.ok(await js(`[...document.querySelectorAll('.tc-msg.mine')].some(m=>m.querySelector('.tc-ticks svg path')?.getAttribute('d').startsWith('M2 12.5'))`),'two ticks once it is on their Macs (blue: everyone in this chat read it)');
  // The drawer resizes from its left edge.
  const w0=await js(`document.querySelector('.tc').getBoundingClientRect().width`);
  await js(`(()=>{const h=document.querySelector('.tc-resize'),r=h.getBoundingClientRect();h.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,clientX:r.left+2,clientY:300}));window.dispatchEvent(new MouseEvent('mousemove',{clientX:r.left-150,clientY:300}));window.dispatchEvent(new MouseEvent('mouseup',{}))})()`);await delay(200);
  assert.ok(await js(`document.querySelector('.tc').getBoundingClientRect().width`)>w0+100,'drawer wider');
  await shot('1-chat');
  assert.equal(await js(`document.querySelector('.tc-link-out')?.getAttribute('href')`),'https://terminai.xyz/download/mac','links are clickable');
  // A half-written message stays when the chat closes and opens again.
  await js(`(()=>{const i=document.querySelector('.tc-chat textarea, .tc-chat input[type=text], .tc-compose textarea');const set=Object.getOwnPropertyDescriptor(i.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set;set.call(i,'draft to Matteo');i.dispatchEvent(new Event('input',{bubbles:true}))})()`);await delay(200);
  await js(`document.querySelector('[aria-label^="Team chat"]').click()`);await delay(300);await js(`document.querySelector('[aria-label^="Team chat"]').click()`);await delay(500);
  assert.equal(await js(`(document.querySelector('.tc-chat textarea, .tc-chat input[type=text], .tc-compose textarea')||{}).value`),'draft to Matteo','draft kept');
  // A picture opens big over the app, with Open in Files; Escape closes it.
  for(let i=0;i<40&&!await js(`!!document.querySelector('.tc-img img')`);i++)await delay(250);
  await js(`document.querySelector('.tc-img').click()`);await delay(300);
  assert.ok(await js(`!!document.querySelector('.tc-viewer img')&&[...document.querySelectorAll('.tc-viewer button')].some(b=>b.textContent==='Open in Files')`),'picture popup with Open in Files');
  await shot('1b-picture');
  await js(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))`);await delay(200);
  assert.ok(await js(`!document.querySelector('.tc-viewer')`),'Escape closes it');
  await js(`[...document.querySelectorAll('.tc-tabs button')].find(b=>b.textContent==='Files').click()`);
  for(let i=0;i<30&&!await js(`document.querySelectorAll('.tc-frow:not(.tc-folder)').length===3`);i++)await delay(200);
  assert.equal(await js(`document.querySelectorAll('.tc-frow:not(.tc-folder)').length`),3,'three files at the top');
  // Folders: Sales holds Universities, which holds the deck.
  assert.deepEqual(await js(`[...document.querySelectorAll('.tc-folder .tc-file-name')].map(n=>n.firstChild.textContent)`),['Sales'],'one folder at the top');
  await js(`document.querySelector('.tc-folder .tc-fmain').click()`);await delay(200);
  await js(`document.querySelector('.tc-folder .tc-fmain').click()`);await delay(200);
  assert.ok(await js(`[...document.querySelectorAll('.tc-frow:not(.tc-folder) .tc-file-name')].some(n=>n.textContent.startsWith('Warwick deck.pdf'))`),'the deck inside Sales/Universities');
  assert.equal(await js(`[...document.querySelectorAll('.tc-crumb')].map(b=>b.textContent).join('/')`),'All files/Sales/Universities');
  await shot('2b-folder');
  await js(`document.querySelector('.tc-crumb').click()`);await delay(200);
  await js(`document.querySelector('.tc-access-btn').click()`);await delay(200);
  await js(`[...document.querySelectorAll('.tc-access-pop .pp-seg button')].find(b=>b.textContent==='Products').click()`);await delay(300);
  await shot('2-files');
  await js(`[...document.querySelectorAll('.tc-tabs button')].find(b=>b.textContent==='People').click()`);
  for(let i=0;i<30&&!await js(`document.querySelectorAll('.pp-list li').length===3`);i++)await delay(200);
  assert.equal(await js(`document.querySelectorAll('.pp-list li').length`),3,'three people');
  await js(`[...document.querySelectorAll('.pp-scope')].find(b=>!b.disabled).click()`);await delay(300);
  assert.ok(await js(`[...document.querySelectorAll('.pp-chip.on')].some(b=>b.textContent==='mm.org')`),'Sofia limited to mm.org, shown as a chip');
  await shot('3-people');
  // The chat's bell turns its sound off and on (saved as sounds.chat).
  await js(`[...document.querySelectorAll('.tc-tabs button')].find(b=>b.textContent==='Chat').click()`);await delay(200);
  await js(`document.querySelector('.tc-bell').click()`);await delay(600);
  assert.equal(await js(`window.term.prefs.get().then(p=>p.sounds.chat)`),false,'bell mutes the chat');
  assert.ok(await js(`document.querySelector('.tc-bell').classList.contains('off')`),'bell shows off');
  await js(`document.querySelector('.tc-bell').click()`);await delay(600);
  assert.equal(await js(`window.term.prefs.get().then(p=>p.sounds.chat)`),true,'and back on');
  // Members › Invite someone: role and access as segments; Only some shows the products; nothing picked blocks the invite.
  await js(`document.querySelector('[aria-label^="Team chat"]').click()`);await delay(300);
  await js(`document.querySelector('[aria-label="Sync"]').click()`);await delay(800);
  await js(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Members').click()`);
  for(let i=0;i<30&&!await js(`!!document.querySelector('.m-invite')`);i++)await delay(200);
  assert.ok(await js(`[...document.querySelectorAll('.m-invite .mi-seg button')].map(b=>b.textContent).join()==='Admin,Member,Viewer,All products,Only some'`),'role and access segments');
  await js(`[...document.querySelectorAll('.m-invite .mi-seg button')].find(b=>b.textContent==='Only some').click()`);await delay(200);
  assert.ok(await js(`document.querySelector('.m-invite .btn.primary').disabled`),'no product picked: cannot invite yet');
  // No product known in this test workspace yet: add mm.org with + New.
  await js(`document.querySelector('.m-invite .pp-chip.add').click()`);await delay(150);
  await js(`(()=>{const i=document.querySelector('.m-invite .pp-new');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,'mm.org');i.dispatchEvent(new Event('input',{bubbles:true}));i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))})()`);await delay(200);
  assert.ok(await js(`!document.querySelector('.m-invite .btn.primary').disabled&&/Only mm.org/.test(document.querySelector('.m-invite').textContent)`),'mm.org picked');
  await js(`document.querySelector('.m-invite').scrollIntoView()`);win.show();win.focus();win.webContents.invalidate();await delay(1200);await shot('4-invite');
  // A new organisation from Sync: made, picked, and listed next to the first one.
  if(!await js(`!!document.querySelector('.team-side')`)){await js(`document.querySelector('[aria-label="Sync"]').click()`);await delay(800)}
  await js(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='+ New organisation').click()`);await delay(200);
  await js(`(()=>{const i=document.querySelector('.team-neworg input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,'Second Org');i.dispatchEvent(new Event('input',{bubbles:true}))})()`);await delay(200);await js(`document.querySelector('.team-neworg button').click()`);
  for(let i=0;i<30&&!await js(`document.querySelectorAll('.team-side select[aria-label="Organisation"] option').length===2`);i++)await delay(200);
  assert.equal(await js(`[...document.querySelector('.team-side select[aria-label="Organisation"]').selectedOptions].map(o=>o.textContent).join()`),'Second Org','new organisation picked');
  assert.ok(await js(`window.term.prefs.get().then(p=>!!p.workspaceId)`),'remembered');
  console.log('PASS team drawer: chat with faces, files with access chips, people with product chips, invite form, new organisation');app.quit();
 })().catch(e=>{console.error(e);app.exit(1)})}));
 setTimeout(()=>app.exit(1),70000).unref();require('../out/main/index.js');
}
