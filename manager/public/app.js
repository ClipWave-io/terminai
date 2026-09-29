const app=document.querySelector('#app'),notice=document.querySelector('#notice'),identity=document.querySelector('#identity');
const roles=['owner','admin','member','viewer'],classes=['general','developer','analyst','marketing'];
let me,companyId,activeConversation,fieldId=0,setupState,dashboardTab='overview',contentRoot=app;
const landing=document.querySelector('#landing'),workspaceShell=document.querySelector('#workspace-shell');
const inviteToken=new URLSearchParams(location.hash.slice(1)).get('invite');
const setupToken=new URLSearchParams(location.hash.slice(1)).get('setup');
if(inviteToken||setupToken)history.replaceState(null,'',location.pathname);
function el(tag,value,attributes={}){const node=document.createElement(tag);if(value!==undefined)node.textContent=value;for(const[key,v]of Object.entries(attributes))node.setAttribute(key,v);return node;}
function message(value){notice.textContent=value;}
async function api(path,method='GET',data){const response=await fetch(path,{method,credentials:'same-origin',headers:data?{'Content-Type':'application/json'}:{},body:data?JSON.stringify(data):undefined});const result=await response.json();if(!response.ok)throw new Error(result.error||'Request failed.');return result;}
function run(fn){return async event=>{event?.preventDefault();message('');const button=event?.submitter;if(button)button.disabled=true;try{await fn(event);}catch(error){message(error.message);}finally{if(button)button.disabled=false;}};}
function button(label,fn,secondary=false){const b=el('button',label,{type:'button'});if(secondary)b.className='secondary';b.addEventListener('click',run(fn));return b;}
function field(form,label,name,type='text',value='',options){const wrap=el('div'),caption=el('label',label),input=el(options?'select':type==='textarea'?'textarea':'input');input.name=name;input.id=`field-${++fieldId}`;caption.htmlFor=input.id;if(options)for(const option of options)input.append(el('option',option,{value:option}));else if(type!=='textarea')input.type=type;input.value=value;input.required=true;if(type==='password')input.minLength=12;input.autocomplete=name==='setupToken'?'off':name==='email'?'email':name==='name'?'name':name==='companyName'?'organization':name==='currentPassword'?'current-password':type==='password'?'new-password':'off';wrap.append(caption,input);form.append(wrap);return input;}
function form(parent,title,onSubmit){const section=el('section'),heading=el('h2',title),f=el('form');section.append(heading,f);parent.append(section);f.addEventListener('submit',run(async()=>onSubmit(Object.fromEntries(new FormData(f)),f)));return f;}
function submit(f,label){f.append(el('button',label,{type:'submit'}));}
function section(title){const s=el('section');s.append(el('h2',title));contentRoot.append(s);return s;}
function base(){return `/api/companies/${companyId}`;}
function link(label,hash){return el('a',label,{href:hash,class:'text-link'});}
function authLayout(title,copy){
  app.replaceChildren();identity.textContent='';
  const layout=el('div',undefined,{class:'auth-layout'}),intro=el('div',undefined,{class:'auth-intro'}),card=el('div',undefined,{class:'auth-card'});
  intro.append(el('span','A SPACE FOR YOUR TEAM',{class:'eyebrow'}),el('h1',title),el('p',copy),el('div','t↗',{class:'auth-art','aria-hidden':'true'}));layout.append(intro,card);app.append(layout);return card;
}
async function start(){
  const route=location.hash.slice(1),showWorkspace=Boolean(inviteToken||setupToken||['workspace','signin','setup'].includes(route));
  landing.hidden=showWorkspace;workspaceShell.hidden=!showWorkspace;
  if(!showWorkspace){identity.textContent='';document.title='TerminAI — The terminal of the future';return;}
  document.title='Team workspace — TerminAI';message('');app.replaceChildren(el('p','Opening your workspace…'));contentRoot=app;
  setupState=await api('/api/setup');
  try{me=await api('/api/me');}catch(error){if(!['Sign in to continue.','Session expired. Sign in again.'].includes(error.message))throw error;me=null;}
  if(inviteToken){showInvitation();return;}
  if(me){await workspace();return;}
  if(route==='setup'||setupToken){showSetup();return;}
  showSignIn();
}
function showSignIn(){
  const card=authLayout('Good to have\nyou here.','Your people, approved tools and shared conversations. Together in one workspace.');
  const f=form(card,'Sign in to your team',async data=>{await api('/api/auth/login','POST',data);me=await api('/api/me');await workspace();});
  field(f,'Email','email','email');const password=field(f,'Password','password','password');password.removeAttribute('minlength');password.autocomplete='current-password';submit(f,'Open workspace ↗');
  const help=el('p','Joining a team? Use the invitation link from your company administrator. You don’t need a setup token.',{class:'form-links'});card.append(help);
  if(setupState.setupRequired){card.append(el('p','This workspace is waiting for its first owner.',{class:'muted'}),link('I’m the owner — set up this workspace →','#setup'));}
}
function showSetup(){
  if(!setupState.setupRequired){showSignIn();message('This workspace is already set up. Sign in, or ask your administrator for an invitation.');return;}
  const card=authLayout('A good place\nto begin.','Set up your company once. Then invite your team with private links—no setup token needed for them.');
  const help=el('details',undefined,{class:'token-help'});help.open=!setupToken;
  help.append(el('summary','Where do I get the owner setup token?'));
  const list=el('ol');
  for(const text of ['Open Railway and select the project hosting this website.','Select the TerminAI manager service, then open Variables.','Reveal and copy SETUP_TOKEN. Paste its value below. This is not a Railway API token or an AI API key.','If SETUP_TOKEN is missing, the deployment owner must generate a random value of at least 32 characters, save it as a service variable, and deploy the change.'])list.append(el('li',text));
  help.append(list,el('p','Only the deployment owner needs this token. If someone invited you, use their invitation link instead.'),el('a','Open Railway ↗',{href:'https://railway.com/dashboard',target:'_blank',rel:'noopener noreferrer'}));card.append(help);
  if(!setupState.setupEnabled){card.append(el('h2','Owner setup is not enabled yet'),el('p','The deployment owner must configure a SETUP_TOKEN with at least 32 characters in Railway, then deploy and refresh this page.'));card.append(button('Check again',start,true));return;}
  const f=form(card,'Create your company',async data=>{await api('/api/setup','POST',data);me=await api('/api/me');await workspace();message('Your company is ready. Invite your team below. The deployment owner can now remove SETUP_TOKEN from Railway.');});
  const token=field(f,'Owner setup token','setupToken','password',setupToken||'');token.minLength=32;token.spellcheck=false;token.autocomplete='off';
  if(setupToken){token.type='hidden';token.parentElement.hidden=true;f.append(el('p','Your private setup link includes the owner token.'));}
  field(f,'Your name','name');field(f,'Work email','email','email');field(f,'Create password','password','password');f.append(el('small','Use at least 12 characters. You’ll use this password to sign in on the web and in TerminAI.'));field(f,'Company name','companyName');submit(f,'Create company ↗');card.append(link('Already invited? Back to sign in','#signin'));
}
function showInvitation(){const card=authLayout('You’re invited.','Bring your ideas. Your team has made a space for you.');const f=form(card,'Join your company',async data=>{await api('/api/auth/accept-invite','POST',{...data,token:inviteToken});location.replace('/#workspace');});f.append(el('p','If you already have an account, enter its current password. Otherwise choose a password with at least 12 characters.'));field(f,'Your name','name');field(f,'Password','password','password');submit(f,'Accept invitation ↗');}
async function workspace(){
  landing.hidden=true;workspaceShell.hidden=false;app.replaceChildren();identity.textContent=me.user.name;contentRoot=app;
  const top=el('div',undefined,{class:'dashboard-head'}),greeting=el('div');greeting.append(el('span','YOUR TEAM, IN SYNC',{class:'eyebrow'}),el('h1',`Welcome, ${me.user.name.split(' ')[0]}.`));top.append(greeting,button('Sign out',async()=>{await api('/api/auth/logout','POST',{});location.replace('/#signin');location.reload();},true));app.append(top);
  if(!me.companies.length){app.append(el('p','You have no active company memberships. Ask an owner for an invitation.'));return;}
  if(!me.companies.some(c=>c.id===companyId))companyId=me.companies[0].id;
  const selector=el('select',undefined,{'aria-label':'Company'});for(const c of me.companies)selector.append(el('option',`${c.name} · ${c.role} · ${c.classification}`,{value:c.id}));selector.value=companyId;selector.addEventListener('change',run(async()=>{companyId=selector.value;activeConversation=null;await workspace();}));app.append(selector);
  const company=me.companies.find(c=>c.id===companyId),admin=['owner','admin'].includes(company.role);
  const layout=el('div',undefined,{class:'dashboard-layout'}),nav=el('nav',undefined,{class:'dashboard-nav','aria-label':'Workspace sections'}),content=el('div',undefined,{class:'dashboard-content'});layout.append(nav,content);app.append(layout);contentRoot=content;
  const sections=[['overview','◫ Overview'],...(admin?[['team','♧ People']]:[]),['tools','⌘ Tools'],['conversations','☰ Conversations'],['security','⌑ Account']];
  if(!sections.some(([id])=>id===dashboardTab))dashboardTab='overview';
  for(const[id,label]of sections){const b=button(label,async()=>{dashboardTab=id;await workspace();},true);b.className=dashboardTab===id?'active':'';if(id===dashboardTab)b.setAttribute('aria-current','page');nav.append(b);}
  if(dashboardTab==='overview'){
    const intro=section('Make this space yours');intro.append(el('p','Connect your desktop, bring your agents, and share only what you choose.'));
    const steps=el('ol');for(const text of ['Open Team in TerminAI on your Mac.','Enter '+location.origin+' as your manager URL, and sign in with this account.','Use Claude Code or Codex in a terminal tab. Your agent account is separate from your team login.'])steps.append(el('li',text));intro.append(steps);
    if(admin)intro.append(button('Invite your team ↗',async()=>{dashboardTab='team';await workspace();}));
    if(company.role==='owner'){const f=form(content,'Company sharing policy',async data=>{await api(base(),'PATCH',{name:data.name,defaultVisibility:data.defaultVisibility,allowCompanySharing:data.allowCompanySharing==='yes'});me=await api('/api/me');await workspace();message('Sharing policy saved.');});field(f,'Company name','name','text',company.name);field(f,'New conversation visibility','defaultVisibility','text',company.defaultVisibility,['owner','company']);field(f,'Allow company sharing','allowCompanySharing','text',company.allowCompanySharing?'yes':'no',['yes','no']);f.append(el('small','Disabling sharing makes existing shared conversations private. Re-enabling does not automatically re-share them.'));submit(f,'Save policy');}
  }
  if(dashboardTab==='team'&&admin)await members(company);
  if(dashboardTab==='tools')await tools(admin);
  if(dashboardTab==='conversations')await conversations(company);
  if(dashboardTab==='security'){
    const security=section('Signed-in devices'),sessions=await api('/api/auth/sessions');for(const session of sessions.sessions){const row=el('div',undefined,{class:'item row'});row.append(el('span',`${session.client} · ${new Date(session.created_at).toLocaleString()}${session.current?' · this session':''}`));row.append(button('Revoke session',async()=>{await api(`/api/auth/sessions/${session.id}`,'DELETE');if(session.current)location.reload();else await workspace();},true));security.append(row);}
    const pf=form(content,'Change password',async data=>{await api('/api/auth/password','POST',data);location.reload();});field(pf,'Current password','currentPassword','password');field(pf,'New password','password','password');submit(pf,'Change password and sign out everywhere');
  }
}
async function members(company){const s=section('Team members'),{members}=await api(`${base()}/members`);for(const member of members){const row=el('div',undefined,{class:'item'});row.append(el('strong',`${member.name} · ${member.email}`));const f=el('form');field(f,'Role','role','text',member.role,company.role==='owner'?roles:['member','viewer']);field(f,'Classification','classification','text',member.classification,classes);if(company.role==='owner'||!['owner','admin'].includes(member.role)){submit(f,'Save member');f.addEventListener('submit',run(async()=>{await api(`${base()}/members/${member.id}`,'PATCH',Object.fromEntries(new FormData(f)));me=await api('/api/me');await workspace();}));f.append(button('Remove from company',async()=>{if(confirm(`Remove ${member.name} from this company?`)){await api(`${base()}/members/${member.id}`,'DELETE');me=await api('/api/me');await workspace();}},true));row.append(f);}else row.append(el('p',`${member.role} · ${member.classification}`));s.append(row);}
  const invite=form(contentRoot,'Invite a team member',async data=>{const result=await api(`${base()}/invites`,'POST',data);const output=el('div');output.append(el('p','Send this private invitation link to the intended recipient. It expires after 48 hours and is shown only now.'),el('a',result.inviteUrl,{href:result.inviteUrl}));invite.append(output);});field(invite,'Recipient email','email','email');field(invite,'Role','role','text','member',company.role==='owner'?['admin','member','viewer']:['member','viewer']);field(invite,'Classification','classification','text','general',classes);submit(invite,'Create invitation');
  const pending=section('Recent invitations'),{invites}=await api(`${base()}/invites`);if(!invites.length)pending.append(el('p','No invitations yet. Invite your first teammate above.',{class:'empty-state'}));for(const invite of invites){const row=el('div',undefined,{class:'item row'});row.append(el('span',`${invite.email} · ${invite.role} · ${invite.accepted_at?'accepted':invite.revoked_at?'revoked':new Date(invite.expires_at)<new Date()?'expired':'pending'}`));if(!invite.accepted_at&&!invite.revoked_at&&(company.role==='owner'||invite.role!=='admin'))row.append(button('Revoke',async()=>{await api(`${base()}/invites/${invite.id}`,'DELETE');await workspace();},true));pending.append(row);}
}
async function tools(admin){const s=section('Approved MCP tools'),{catalog}=await api(`${base()}/catalog`);s.append(el('p','Assignments make approved setup available in the desktop client. They do not install software or start an agent here.'));
  for(const tool of catalog){const block=el('div',undefined,{class:'item'});block.append(el('h3',`${tool.name} · ${tool.assigned?'assigned to you':'not assigned to you'}`),el('p',tool.description),el('a','Setup documentation',{href:tool.docsUrl,target:'_blank',rel:'noopener noreferrer'}));if(tool.setupRequired)block.append(el('p','The service operator must configure the Google Ads MCP endpoint before setup is available.'));
    if(admin){const f=el('form');for(const [type,values]of [['role',roles],['classification',classes]]){f.append(el('strong',`Assign by ${type}`));const choices=el('div',undefined,{class:'choices'});for(const value of values){const label=el('label',value),checkbox=el('input',undefined,{type:'checkbox',name:type,value});checkbox.checked=tool.assignments.some(a=>a.subject_type===type&&a.subject===value);label.prepend(checkbox);choices.append(label);}f.append(choices);}submit(f,'Save assignments');f.addEventListener('submit',run(async()=>{const data=new FormData(f);await api(`${base()}/catalog/${tool.id}/assignments`,'PUT',{roles:data.getAll('role'),classifications:data.getAll('classification')});await workspace();}));block.append(f);}s.append(block);
  }
}
async function conversations(company){const s=section('Conversations'),{conversations}=await api(`${base()}/conversations`);if(!conversations.length)s.append(el('p','A fresh start. Create a conversation below when you’re ready to share.',{class:'empty-state'}));for(const conversation of conversations){const row=el('div',undefined,{class:'item row'});row.append(button(conversation.title,async()=>{activeConversation=conversation;await workspace();},true),el('small',conversation.visibility==='owner'?'Private to owner':'Company shared'));s.append(row);}
  if(company.role!=='viewer'){const f=form(contentRoot,'New conversation',async data=>{const result=await api(`${base()}/conversations`,'POST',data);activeConversation=result.conversation;await workspace();});field(f,'Title','title');field(f,'Visibility','visibility','text',company.defaultVisibility,company.allowCompanySharing?['owner','company']:['owner']);submit(f,'Create conversation');}
  if(!activeConversation)return;
  const refreshed=conversations.find(c=>c.id===activeConversation.id);if(!refreshed){activeConversation=null;return;}activeConversation=refreshed;
  const detail=section(activeConversation.title);detail.append(el('small','Stored conversation history. Assistant messages are imported by clients; this service does not run an AI model.'));
  const messages=el('div');detail.append(messages);async function load(after){const result=await api(`${base()}/conversations/${activeConversation.id}/messages${after?`?after=${after}`:''}`);for(const message of result.messages){const m=el('div',undefined,{class:'message'});m.append(el('strong',`${message.authorName||message.authorId} · ${message.kind}`),el('div',message.content));messages.append(m);}if(result.hasMore){const more=button('Load more messages',async()=>{more.remove();await load(result.nextCursor);},true);detail.append(more);}}await load();
  if(company.role!=='viewer'){const f=el('form');field(f,'Add a message','content','textarea');submit(f,'Save message');f.addEventListener('submit',run(async()=>{await api(`${base()}/conversations/${activeConversation.id}/messages`,'POST',{content:new FormData(f).get('content'),kind:'user',clientMessageId:crypto.randomUUID()});await workspace();}));detail.append(f);}
  if(activeConversation.ownerId===me.user.id&&company.role!=='viewer'){const f=form(contentRoot,'Conversation sharing',async (data,form)=>{await api(`${base()}/conversations/${activeConversation.id}`,'PATCH',{title:data.title,visibility:data.visibility,allowedRoles:new FormData(form).getAll('allowedRoles')});await workspace();});field(f,'Title','title','text',activeConversation.title);field(f,'Visibility','visibility','text',activeConversation.visibility,company.allowCompanySharing?['owner','company']:['owner']);const choices=el('div',undefined,{class:'choices'});for(const role of roles){const label=el('label',role),checkbox=el('input',undefined,{type:'checkbox',name:'allowedRoles',value:role});checkbox.checked=activeConversation.allowedRoles.includes(role);label.prepend(checkbox);choices.append(label);}f.append(el('p','Roles allowed to read a company-shared conversation:'),choices);submit(f,'Save conversation');}
}
window.addEventListener('hashchange',run(start));
run(start)();
