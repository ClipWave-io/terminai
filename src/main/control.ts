import {createServer} from 'node:http'
import {randomBytes,randomUUID,timingSafeEqual} from 'node:crypto'
import {mkdirSync,writeFileSync,readFileSync,renameSync,unlinkSync,chmodSync,statSync} from 'node:fs'
import {join,basename,isAbsolute} from 'node:path'
import type {BrowserWindow} from 'electron'
import * as ptys from './pty'
import * as store from './store'
import type {SavedTab,Task,TaskListPage} from '../shared/types'

/**
 * Local command channel for the terminal tabs, behind `terminai list|open|send|read|close|focus|show`
 * and `terminai todo start|done|reopen` (resources/terminai.cjs). Same boundary as the browser bridge: loopback only, a random token
 * in a 0600 file next to prefs, the file gone on quit. Every PTY gets its path as TERMINAI_CONTROL.
 */
type Deps={window:()=>BrowserWindow|null;activeTab:()=>string|null;focused:(id:string)=>void;show:(path:string)=>void
  todo:{track:(action:unknown,query:unknown,session?:{tab:string;name:string})=>Promise<{scope:string;task:Task}>
    add:(to:unknown,title:unknown,note?:unknown)=>Promise<{scope:string;page:string;task:Task}>;about:(list:unknown,text:unknown)=>{lists:TaskListPage[]}}}
const COMMANDS=['list','open','send','read','close','focus','show','task']

const pending=new Map<string,(result:unknown)=>void>()
/** The renderer owns the tab list: ask it to act and wait for its answer, null when none comes. */
function ask(win:BrowserWindow|null,kind:string,input:object,timeout=2000):Promise<unknown>{
  if(!win||win.isDestroyed())return Promise.reject(Error('Open the TerminAI window first.'))
  const reqId=randomUUID()
  return new Promise(resolve=>{
    const timer=setTimeout(()=>{pending.delete(reqId);resolve(null)},timeout)
    pending.set(reqId,result=>{clearTimeout(timer);pending.delete(reqId);resolve(result)})
    win.webContents.send('tab:request',{reqId,kind,input})
  })
}
export function controlReply(reply:{reqId?:unknown;result?:unknown}){if(typeof reply?.reqId==='string')pending.get(reply.reqId)?.(reply.result)}

// Name and group of the tabs opened here, for a `list` that lands before the renderer has saved prefs.
const opened=new Map<string,{name?:string;group?:string}>()
function liveTab(id:unknown){const s=typeof id==='string'?ptys.list().find(t=>t.id===id):undefined;if(!s)throw Error('Unknown tab');return s}
function text(value:unknown,max:number,field:string){if(value===undefined||value===null||value==='')return undefined;if(typeof value!=='string'||value.length>max)throw Error(`Invalid ${field}`);return value}
function count(value:unknown,min:number,max:number,field:string){if(value===undefined)return undefined;if(!Number.isInteger(value)||(value as number)<min||(value as number)>max)throw Error(`Invalid ${field}`);return value as number}
function isFolder(path:string){try{return statSync(path).isDirectory()}catch{return false}}
/** What a terminal shows of raw output, near enough: escapes dropped, carriage returns honoured. */
function plain(raw:string){
  return raw.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g,'').replace(/\x1b[P^_][^\x1b]*\x1b\\/g,'').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'').replace(/\x1b[ -/]*[0-~]/g,'')
    .split('\n').map(line=>line.replace(/\r+$/,'')).map(line=>{let l=line.slice(line.lastIndexOf('\r')+1);while(/[^\x08]\x08/.test(l))l=l.replace(/[^\x08]\x08/g,'');return l.replace(/[\x00-\x08\x0b-\x1f\x7f]/g,'').trimEnd()})
}
function tail(lines:string[],n:number){let end=lines.length;while(end>0&&!lines[end-1].trim())end--;return lines.slice(Math.max(0,end-n),end).join('\n')}

async function run(command:string,a:any,d:Deps):Promise<unknown>{
  switch(command){
    case 'list':{
      const saved=store.load().tabs,rank=(id:string)=>{const i=saved.findIndex(t=>t.ptyId===id);return i<0?saved.length:i}
      return ptys.list().sort((x,y)=>rank(x.id)-rank(y.id)).map(({id,exited})=>{
        const tab=saved.find(t=>t.ptyId===id),meta=opened.get(id),agent=ptys.agentOf(id),cwd=ptys.cwdOf(id)
        return {id,name:tab?.customTitle||tab?.name||meta?.name||null,title:tab?.title||meta?.name||basename(cwd)||'shell',cwd,group:tab?.group||meta?.group||null,
          active:id===d.activeTab(),agent:{kind:agent.kind,alive:agent.alive},status:exited?'exited':ptys.statusOf(id),question:exited?'':ptys.questionOf(id),pid:ptys.pidOf(id)||null}
      })
    }
    case 'open':{
      const win=d.window();if(!win||win.isDestroyed())throw Error('Open the TerminAI window first.')
      if(typeof a.cwd!=='string'||!isAbsolute(a.cwd)||!isFolder(a.cwd))throw Error('cwd must be an existing folder')
      const cmd=text(a.command,20000,'command'),name=text(a.name,100,'name'),group=text(a.group,100,'group')
      // The size of the tab in view, so a program started here draws for the width it will be shown at.
      const active=d.activeTab(),current=active?ptys.sizeOf(active):null
      const cols=count(a.cols,2,1000,'cols')??current?.cols??80,rows=count(a.rows,2,1000,'rows')??current?.rows??24
      const browserKey=randomUUID(),{id,cwd}=ptys.createSession({cwd:a.cwd,cols,rows,browserKey})
      const tab:SavedTab={ptyId:id,cwd,title:name||basename(cwd)||'shell',customTitle:name,name,group,browserKey,notes:'',focusedMs:0}
      opened.set(id,{name,group})
      // Saved here too, so the tab comes back after a restart even if the window never took it.
      store.save({tabs:[...store.load().tabs.filter(t=>t.ptyId!==id),tab]})
      if(cmd)ptys.execWhenReady(id,cmd)
      await ask(win,'adopt',{...tab,id,background:a.background!==false})
      return {id}
    }
    case 'send':{
      const s=liveTab(a.id)
      if(s.exited)throw Error('The tab has exited')
      if(typeof a.text!=='string'||a.text.length>100000)throw Error('Invalid text')
      if(a.text)ptys.write(s.id,a.text)
      // A TUI takes an Enter glued to the text as part of a paste; on its own it submits. Long text goes
      // in as the program reads it, so the Enter waits for that (within the CLI's 30 s).
      if(a.enter!==false){await Promise.race([ptys.written(s.id),new Promise(r=>setTimeout(r,2e4))]);await new Promise(r=>setTimeout(r,150));ptys.write(s.id,'\r')}
      return {ok:true}
    }
    case 'read':{
      const {id}=liveTab(a.id),lines=count(a.lines,1,5000,'lines')??80
      const shown=await ask(d.window(),'read',{id,lines}).catch(()=>null)
      // xterm's own buffer is what the user sees; the raw PTY output is the fallback when no pane is mounted.
      return Array.isArray(shown)&&shown.length?{id,source:'xterm',text:tail(shown.map(String),lines)}:{id,source:'buffer',text:tail(plain(ptys.bufferOf(id)),lines)}
    }
    case 'close':{
      const {id}=liveTab(a.id)
      // The renderer drops the tab the way ⌘W does once confirmed (no sheet: nobody would answer it),
      // so ⇧⌘T can still bring it back for the 60 s grace.
      if(await ask(d.window(),'close',{id}).catch(()=>null)!==true){ptys.closeSession(id);store.save({tabs:store.load().tabs.filter(t=>t.ptyId!==id)})}
      opened.delete(id)
      return {ok:true}
    }
    case 'focus':{
      const {id}=liveTab(a.id)
      if(await ask(d.window(),'focus',{id})!==true)throw Error('That tab is not in the TerminAI window')
      d.focused(id)
      return {ok:true}
    }
    // A file in the Files pane beside the tabs (PDF, image, text, code), as a Finder "Open with" does.
    case 'show':{
      if(typeof a.path!=='string'||!isAbsolute(a.path))throw Error('path must be an absolute file path')
      let file=false;try{file=statSync(a.path).isFile()}catch{}
      if(!file)throw Error(`No such file: ${a.path}`)
      d.show(a.path)
      return {ok:true,path:a.path}
    }
    // The To-do from a tab: a task added to a page, a private list described, or a task started, done or reopened
    // (starting links the row to the tab, by the key that outlives a restart).
    case 'task':{
      if(a.action==='add'){const {scope,page,task}=await d.todo.add(a.to,a.title,a.note);return {id:task.id,title:task.title,status:task.status,scope,page}}
      if(a.action==='about')return {lists:d.todo.about(a.list,a.text).lists}
      const s=typeof a.tab==='string'?ptys.list().find(t=>t.id===a.tab):undefined,tab=s&&store.load().tabs.find(t=>t.ptyId===s.id),meta=s&&opened.get(s.id)
      const name=s?tab?.customTitle||tab?.name||meta?.name||tab?.title||basename(ptys.cwdOf(s.id))||'shell':''
      const {scope,task}=await d.todo.track(a.action,a.task,s?{tab:ptys.workspaceKeyOf(s.id),name}:undefined)
      return {id:task.id,title:task.title,status:task.status,scope,...(s&&a.action==='start'?{tab:{id:s.id,name}}:{})}
    }
  }
  throw Error('Unknown command')
}

export async function startControl(directory:string,deps:Deps) {
  mkdirSync(directory,{recursive:true})
  const token=randomBytes(32).toString('hex'),file=join(directory,'control.json')
  const server=createServer(async(req,res)=>{
    res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store')
    const fail=(status:number,error:string)=>{res.writeHead(status);res.end(JSON.stringify({error}))}
    if(!['127.0.0.1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress||''))return fail(403,'Forbidden')
    const provided=req.headers.authorization?.replace(/^Bearer /,'')||''
    if(!/^[a-f0-9]{64}$/.test(provided)||!timingSafeEqual(Buffer.from(provided),Buffer.from(token)))return fail(401,'Unauthorized')
    // A web page can reach loopback as well; whatever a browser sends carries one of these.
    if(req.headers.origin||req.headers['sec-fetch-site'])return fail(403,'Forbidden')
    if(req.method!=='POST')return fail(405,'POST only')
    if(!/^application\/json\b/.test(req.headers['content-type']||''))return fail(415,'JSON only')
    if(req.url!=='/control')return fail(404,'Not found')
    try {
      const chunks:Buffer[]=[];let size=0
      for await(const part of req){size+=part.length;if(size>1000000)throw Error('Request too large');chunks.push(part)}
      const input=JSON.parse(Buffer.concat(chunks).toString('utf8'))
      if(!COMMANDS.includes(input?.command))throw Error('Unknown command')
      res.end(JSON.stringify({result:await run(input.command,input.args&&typeof input.args==='object'?input.args:{},deps)}))
    }catch(e){fail(400,e instanceof Error?e.message:'Control request failed')}
  })
  server.requestTimeout=30000;server.headersTimeout=10000
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)})
  const port=(server.address() as {port:number}).port
  writeFileSync(file+'.tmp',JSON.stringify({port,token,pid:process.pid}),{mode:0o600});chmodSync(file+'.tmp',0o600);renameSync(file+'.tmp',file)
  return {port,close:()=>{server.close();try{if(JSON.parse(readFileSync(file,'utf8')).token===token)unlinkSync(file)}catch{}}}
}
