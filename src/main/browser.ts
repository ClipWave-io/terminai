import { app, BrowserWindow, WebContentsView, session, shell } from 'electron'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { browserUrl, type BrowserState, type BrowserTab, type BrowserProfile } from '../shared/browser'

/** Persistent profiles remain isolated from the privileged app shell and each other. */
export function createBrowserPane(win: BrowserWindow) {
  const file = join(app.getPath('userData'), 'browser-workspace.json')
  let profiles: BrowserProfile[] = [{id:'default',name:'Personal'}], tabs: BrowserTab[] = [], activeId='', profileId='default', owner=''
  let selected: Record<string,string> = {}, error='', bounds={x:0,y:0,width:0,height:0,visible:false}
  const views=new Map<string,WebContentsView>(), configured=new Set<string>()
  try {
    const saved=JSON.parse(readFileSync(file,'utf8'))
    if(Array.isArray(saved.profiles)) profiles=saved.profiles.filter((p:BrowserProfile)=>!p.private&&/^[a-z0-9-]+$/i.test(p.id)&&typeof p.name==='string').slice(0,30)
    if(!profiles.length)profiles=[{id:'default',name:'Personal'}]
    profileId=profiles.some(p=>p.id===saved.profileId)?saved.profileId:profiles[0].id
    if(Array.isArray(saved.tabs)) tabs=saved.tabs.filter((t:BrowserTab)=>typeof t.id==='string'&&profiles.some(p=>p.id===t.profileId)&&typeof t.owner==='string'&&(!t.url||!!browserUrl(t.url))).slice(0,100)
    selected=saved.selected&&typeof saved.selected==='object'?saved.selected:{}
  } catch { /* A damaged workspace never stops the terminal from opening. */ }
  const isPrivate=(id:string)=>profiles.some(p=>p.id===id&&p.private)
  const partition=(id:string)=>(isPrivate(id)?'':'persist:')+'terminai-profile-'+id
  const persist=()=>{try{mkdirSync(app.getPath('userData'),{recursive:true});writeFileSync(file+'.tmp',JSON.stringify({profiles:profiles.filter(p=>!p.private),tabs:tabs.filter(t=>!isPrivate(t.profileId)),selected:Object.fromEntries(Object.entries(selected).filter(([,id])=>tabs.some(t=>t.id===id&&!isPrivate(t.profileId)))),profileId:isPrivate(profileId)?profiles.find(p=>!p.private)?.id:profileId}),{mode:0o600});renameSync(file+'.tmp',file)}catch{error='Could not save browser workspace.'}}
  const active=()=>tabs.find(t=>t.id===activeId)
  const state=():BrowserState=>{const t=active(),c=t?views.get(t.id)?.webContents:undefined;return {url:t?.url||'',title:t?.title||'',loading:c?.isLoading()||false,canGoBack:c?.navigationHistory.canGoBack()||false,canGoForward:c?.navigationHistory.canGoForward()||false,error,tabs:tabs.filter(t=>t.owner===owner).map(t=>({...t})),profiles,activeId,profileId,owner}}
  const publish=()=>{if(!win.isDestroyed())win.webContents.send('browser:state',state())}
  const applyBounds=()=>{for(const [id,view]of views){view.setBounds({x:bounds.x,y:bounds.y,width:bounds.width,height:bounds.height});view.setVisible(id===activeId&&bounds.visible&&bounds.width>0&&bounds.height>0)}}
  const ensureView=(tab:BrowserTab,load=true):WebContentsView=>{
    const existing=views.get(tab.id);if(existing)return existing
    const isolated=session.fromPartition(partition(tab.profileId))
    if(!configured.has(tab.profileId)){
      isolated.setPermissionRequestHandler((_c,_p,callback)=>callback(false));isolated.setPermissionCheckHandler(()=>false)
      isolated.on('will-download',event=>event.preventDefault());configured.add(tab.profileId)
    }
    const view=new WebContentsView({webPreferences:{session:isolated,sandbox:true,contextIsolation:true,nodeIntegration:false,nodeIntegrationInWorker:false,nodeIntegrationInSubFrames:false,webSecurity:true,allowRunningInsecureContent:false,webviewTag:false}})
    views.set(tab.id,view);view.setVisible(false);win.contentView.addChildView(view)
    const c=view.webContents
    const sync=()=>{const url=c.getURL();if(url&&url!=='about:blank')tab.url=url;tab.title=c.getTitle()||tab.url;persist();publish()}
    const guard=(event:Electron.Event,url:string)=>{try{browserUrl(url)}catch{event.preventDefault();error='Only HTTP and HTTPS navigation is allowed.';publish()}}
    c.on('will-navigate',guard);c.on('will-redirect',guard);c.on('will-frame-navigate',e=>guard(e,e.url))
    c.setWindowOpenHandler(({url})=>{try{browserUrl(url);newTab({url,profileId:tab.profileId,group:tab.group,owner:tab.owner},tab.owner===owner)}catch{error='Blocked unsupported popup address.';publish()}return {action:'deny'}})
    c.on('did-start-loading',publish);c.on('did-stop-loading',sync);c.on('did-navigate',sync);c.on('did-navigate-in-page',sync);c.on('page-title-updated',sync)
    c.on('did-fail-load',(_e,code,description,_url,main)=>{if(main&&code!==-3){error=description;publish()}})
    c.on('render-process-gone',()=>{error='The page stopped responding. Reload to try again.';publish()})
    if(load&&tab.url)void c.loadURL(tab.url).catch(()=>{});return view
  }
  const select=(id:string)=>{const t=tabs.find(t=>t.id===id&&t.owner===owner);if(!t)throw Error('Browser tab not found in this session.');activeId=id;profileId=t.profileId;selected[owner]=id;ensureView(t);applyBounds();persist();publish();return state()}
  const newTab=(input:{url?:string;profileId?:string;group?:string;owner?:string}={},foreground=true)=>{
    if(tabs.length>=100)throw Error('Close a tab before opening another (100 tab limit).')
    const pid=input.profileId||profileId;if(!profiles.some(p=>p.id===pid))throw Error('Profile not found.')
    const tab:BrowserTab={id:randomUUID(),url:input.url?browserUrl(input.url):'',title:'New tab',profileId:pid,group:String(input.group||'').slice(0,60),owner:input.owner??owner};tabs.push(tab)
    if(foreground&&tab.owner===owner)select(tab.id);else{ensureView(tab);persist();publish()};return {...tab}
  }
  const selectSession=(key:string)=>{if(typeof key!=='string'||key.length>120)throw Error('Invalid session.');owner=key;activeId='';const t=tabs.find(t=>t.id===selected[owner]&&t.owner===owner)||tabs.find(t=>t.owner===owner);if(t)return select(t.id);applyBounds();publish();return state()}
  const navigate=async(input:unknown,id=activeId)=>{try{const url=browserUrl(input);let tab=tabs.find(t=>t.id===id);if(!tab){const created=newTab();tab=tabs.find(t=>t.id===created.id)!;}error='';tab.url=url;await ensureView(tab,false).webContents.loadURL(url);persist()}catch(e){error=e instanceof Error?e.message:'Unable to load page.'}publish()}
  const action=async(type:string,input:any={})=>{
    if(type==='session')return selectSession(input.owner)
    if(type==='new')return newTab({...input,owner})
    if(type==='select')return select(input.id)
    if(type==='close'){const tab=tabs.find(t=>t.id===input.id&&t.owner===owner);if(!tab)throw Error('Tab not found.');const view=views.get(tab.id);if(view){views.delete(tab.id);win.contentView.removeChildView(view);view.webContents.close()}tabs=tabs.filter(t=>t.id!==tab.id);if(isPrivate(tab.profileId)&&!tabs.some(t=>t.profileId===tab.profileId)){const isolated=session.fromPartition(partition(tab.profileId));await isolated.clearStorageData();await isolated.clearCache();profiles=profiles.filter(p=>p.id!==tab.profileId);configured.delete(tab.profileId);if(profileId===tab.profileId)profileId=profiles[0].id}if(activeId===tab.id){delete selected[owner];selectSession(owner)}persist();publish();return state()}
    if(type==='group'){const tab=tabs.find(t=>t.id===input.id&&t.owner===owner);if(!tab)throw Error('Tab not found.');tab.group=String(input.name||'').trim().slice(0,60);persist();publish();return state()}
    if(type==='private'){if(profiles.length>=30)throw Error('Close a private session before opening another.');const p={id:'private-'+randomUUID(),name:'Private',private:true};profiles.push(p);return newTab({profileId:p.id,owner})}
    if(type==='profile'){if(typeof input.name!=='string'||!input.name.trim()||profiles.length>=30)throw Error('Enter a profile name (maximum 30 profiles).');const p={id:randomUUID(),name:input.name.trim().slice(0,60)};profiles.push(p);profileId=p.id;newTab({profileId:p.id});return p}
    if(type==='use-profile'){if(!profiles.some(p=>p.id===input.id))throw Error('Profile not found.');profileId=input.id;const existing=tabs.find(t=>t.owner===owner&&t.profileId===profileId);if(existing)return select(existing.id);newTab({profileId});return state()}
    throw Error('Unknown browser action.')
  }
  win.once('closed',()=>{persist();for(const view of views.values())if(!view.webContents.isDestroyed())view.webContents.close();views.clear()})
  return {state,navigate,action,selectSession,
    layout(input:typeof bounds){const [w,h]=win.getContentSize();if(!input||![input.x,input.y,input.width,input.height].every(Number.isFinite))throw Error('Invalid browser bounds');const x=Math.max(0,Math.min(w,Math.round(input.x))),y=Math.max(0,Math.min(h,Math.round(input.y)));bounds={x,y,width:Math.max(0,Math.min(w-x,Math.round(input.width))),height:Math.max(0,Math.min(h-y,Math.round(input.height))),visible:input.visible===true};applyBounds()},
    async command(command:string){const t=active();if(!t)return;const c=ensureView(t).webContents;error='';if(command==='back'&&c.navigationHistory.canGoBack())c.navigationHistory.goBack();else if(command==='forward'&&c.navigationHistory.canGoForward())c.navigationHistory.goForward();else if(command==='reload')c.reload();else if(command==='external'){const url=browserUrl(t.url);try{await promisify(execFile)('/usr/bin/open',['-a','Google Chrome',url])}catch{await shell.openExternal(url)}}publish()},
    async automate(command:string,args:any,sessionKey:string){
      if(!/^[a-zA-Z0-9-]{1,120}$/.test(sessionKey))throw Error('Start this agent inside a TerminAI coding session.');
      if(command==='list')return tabs.filter(t=>t.owner===sessionKey)
      if(command==='open'){const tab=newTab({...args,owner:sessionKey},sessionKey===owner);if(sessionKey===owner)win.webContents.send('browser:reveal');return tab}
      const tab=tabs.find(t=>t.id===args.tabId&&t.owner===sessionKey);if(!tab)throw Error('Tab does not belong to this coding session.')
      const c=ensureView(tab).webContents
      if(command==='navigate'){browserUrl(args.url);await navigate(args.url,tab.id);if(error)throw Error(error);return {...tab}}
      if(command==='snapshot')return c.executeJavaScript(`({url:location.href,title:document.title,text:document.body.innerText.slice(0,60000),elements:[...document.querySelectorAll('a,button,input,textarea,select')].slice(0,300).map((e,i)=>{e.setAttribute('data-terminai-id',String(i));return {id:i,tag:e.tagName,text:e.innerText?.slice(0,200),label:e.getAttribute('aria-label'),type:e.getAttribute('type')}})})`)
      if(['click','type'].includes(command)&&!/^\d{1,3}$/.test(String(args.id)))throw Error('Invalid element ID. Take a fresh snapshot.');
      if(command==='click')return c.executeJavaScript(`(()=>{const e=document.querySelector('[data-terminai-id="'+${JSON.stringify(String(args.id))}+'"]');if(!e)throw Error('Take a fresh snapshot.');e.click();return true})()`)
      if(command==='type')return c.executeJavaScript(`(()=>{const e=document.querySelector('[data-terminai-id="'+${JSON.stringify(String(args.id))}+'"]');if(!e||!['INPUT','TEXTAREA'].includes(e.tagName))throw Error('Editable field not found.');const setter=Object.getOwnPropertyDescriptor(e.tagName==='INPUT'?HTMLInputElement.prototype:HTMLTextAreaElement.prototype,'value').set;setter.call(e,${JSON.stringify(String(args.text||''))});e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));return true})()`)
      if(command==='screenshot')return {png:(await c.capturePage()).toPNG().toString('base64')}
      throw Error('Unsupported browser tool.')
    }
  }
}
