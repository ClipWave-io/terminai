// Run with jsdom available on NODE_PATH; no server, database or live credentials.
const {JSDOM}=require('jsdom');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.join(__dirname,'../manager/public'),html=fs.readFileSync(path.join(root,'index.html'),'utf8'),script=fs.readFileSync(path.join(root,'app.js'),'utf8');
const delay=()=>new Promise(r=>setTimeout(r,20));
async function fixture(hash='',settings={}){
 const dom=new JSDOM(html,{url:'https://terminai.test/'+hash,runScripts:'outside-only'}),w=dom.window,calls=[];
 let signedIn=settings.signedIn||false,initialized=settings.initialized||false;
 const company={id:'company-one',name:'Test Company',role:settings.role||'owner',classification:'general',defaultVisibility:'owner',allowCompanySharing:true};
 w.fetch=async(url,options={})=>{
  const data=options.body?JSON.parse(options.body):undefined;calls.push({url,method:options.method,data});let value={},status=200;
  if(url==='/api/setup'&&options.method==='GET')value={setupRequired:!initialized,setupEnabled:!initialized&&settings.setupEnabled!==false};
  else if(url==='/api/setup'){if(data.setupToken!=='x'.repeat(32)){status=403;value={error:'The owner setup token is incorrect. Copy SETUP_TOKEN from Railway.'};}else{signedIn=true;initialized=true;}}
  else if(url==='/api/me'){if(signedIn)value={user:{id:'owner',name:'Test Owner'},companies:[company]};else{status=401;value={error:'Sign in to continue.'};}}
  else if(url.endsWith('/members'))value={members:[{id:'owner',name:'Test Owner',email:'owner@example.test',role:'owner',classification:'general'}]};
  else if(url.endsWith('/invites'))value={invites:[]};
  else if(url.endsWith('/catalog'))value={catalog:[]};
  else if(url.endsWith('/conversations'))value={conversations:[]};
  else if(url==='/api/auth/sessions')value={sessions:[]};
  else throw Error('Unexpected request '+url);
  return {ok:status===200,status,json:async()=>value};
 };
 w.eval(script);await delay();return{dom,w,calls,route:async hash=>{w.location.hash=hash;await delay();}};
}
(async()=>{
 const f=await fixture(),{w}=f,d=w.document;
 assert.equal(f.calls.length,0,'Landing renders without authentication/database calls');assert.equal(d.querySelector('#landing').hidden,false);assert.equal(d.querySelector('#workspace-shell').hidden,true);
 await f.route('#workspace');assert.equal(d.querySelector('#landing').hidden,true);assert.match(d.querySelector('#app').textContent,/Sign in to your team/);assert.equal(d.querySelector('[name=setupToken]'),null);assert.equal(d.querySelector('[name=password]').autocomplete,'current-password');
 await f.route('#setup');assert.match(d.querySelector('#app').textContent,/Railway/);assert.equal(d.querySelector('[name=setupToken]').minLength,32);assert.equal(d.querySelector('[name=password]').minLength,12);
 const form=d.querySelector('#app form');for(const[name,value]of Object.entries({setupToken:'z'.repeat(32),name:'Test Owner',email:'owner@example.test',password:'long test password',companyName:'Test Company'}))form.elements[name].value=value;
 const send=async()=>{form.dispatchEvent(new w.SubmitEvent('submit',{bubbles:true,cancelable:true,submitter:form.querySelector('button[type=submit]')}));await delay();};
 await send();assert.match(d.querySelector('#notice').textContent,/incorrect/);assert.equal(form.elements.name.value,'Test Owner');assert.equal(form.querySelector('button').disabled,false);
 form.elements.setupToken.value='x'.repeat(32);await send();assert.match(d.querySelector('#app').textContent,/Welcome, Test/);assert.match(d.querySelector('#app').textContent,/Company sharing policy/);assert.equal(d.querySelector('.dashboard-nav button[aria-current=page]').textContent,'◫ Overview');
 const nav=label=>Array.from(d.querySelectorAll('.dashboard-nav button')).find(e=>e.textContent.includes(label));
 for(const[label,heading]of [['People','Invite a team member'],['Tools','Approved MCP tools'],['Conversations','New conversation'],['Account','Change password']]){nav(label).click();await delay();assert.match(d.querySelector('.dashboard-content').textContent,new RegExp(heading));}
 await f.route('#home');assert.equal(d.querySelector('#workspace-shell').hidden,true);assert.equal(d.querySelector('#landing').hidden,false);f.dom.window.close();
 const link=await fixture('#setup='+'x'.repeat(32));assert.equal(link.w.location.hash,'');assert.equal(link.w.document.querySelector('[name=setupToken]').type,'hidden');assert.match(link.w.document.querySelector('#app').textContent,/private setup link/);link.dom.window.close();
 const invite=await fixture('#invite='+'i'.repeat(43));assert.equal(invite.w.location.hash,'');assert.match(invite.w.document.querySelector('#app').textContent,/Join your company/);assert.equal(invite.w.document.querySelector('[name=setupToken]'),null);invite.dom.window.close();
 const disabled=await fixture('#setup',{setupEnabled:false});assert.equal(disabled.w.document.querySelector('#app form'),null);assert.match(disabled.w.document.querySelector('#app').textContent,/not enabled/);disabled.dom.window.close();
 const viewer=await fixture('#workspace',{signedIn:true,initialized:true,role:'viewer'});assert.ok(!viewer.w.document.querySelector('#app').textContent.includes('Company sharing policy'));assert.ok(!Array.from(viewer.w.document.querySelectorAll('.dashboard-nav button')).some(b=>b.textContent.includes('People')));Array.from(viewer.w.document.querySelectorAll('.dashboard-nav button')).find(b=>b.textContent.includes('Conversations')).click();await delay();assert.ok(!viewer.w.document.querySelector('#app').textContent.includes('New conversation'));viewer.dom.window.close();
 console.log('PASS: landing, sign-in, owner setup, invalid-token retry, setup success, all dashboard sections, private setup links and invitation routing.');
})().catch(e=>{console.error(e);process.exitCode=1});
