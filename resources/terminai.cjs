#!/usr/bin/env node
// Dependency-free client for TerminAI's local tab control channel (src/main/control.ts).
//   terminai list
//   terminai open --cwd <dir> [--name <n>] [--group <g>] [--foreground] [--cols N --rows N] [--command '<shell line>' | -- <argv...>]
//   terminai send <id> <text...> [--no-enter]
//   terminai read <id> [--lines N]
//   terminai close <id>
//   terminai focus <id>
//   terminai show <file>                                   the file in the Files pane beside the tabs (PDF, image, text)
//   terminai todo [--shared|--personal] [--open] [--mine]   read-only, straight from the files
//   terminai todo map                                      every page: shared columns, private lists with what each is for, open tasks
//   terminai todo start|done|reopen <task id or title>     through the app, which commits it; start links the task to this tab
//   terminai todo add <title> --to <page> [--note <text>]  page: matteo, together, ilai, unassigned or a private list's name
//   terminai todo about <list> <text>                      what a private list is for (empty text clears it)
// Drives the instance named by TERMINAI_CONTROL (set in every TerminAI tab), else the installed app. Prints JSON.
const {readFileSync,readdirSync}=require('node:fs'),{join,resolve}=require('node:path'),{homedir}=require('node:os');
const COMMANDS=['list','open','send','read','close','focus','show','todo'],WRITES=['start','done','reopen','add','about'],SWITCHES=['foreground','no-enter','shared','personal','open','mine'];
// Each word after `--` is typed as one shell word, the way TerminalPane quotes a dropped path.
const quote=s=>/^[A-Za-z0-9_@%+=:,./-]+$/.test(s)?s:`'${s.replace(/'/g,`'\\''`)}'`;
function parse(argv){
 const [command,...rest]=argv,flags={},words=[];
 for(let i=0;i<rest.length;i++){
  const a=rest[i];
  if(a==='--'){flags.command=rest.slice(i+1).map(quote).join(' ');break}
  if(!a.startsWith('--')){words.push(a);continue}
  const eq=a.indexOf('='),key=a.slice(2,eq<0?undefined:eq);
  if(SWITCHES.includes(key)){flags[key]=true;continue}
  const value=eq<0?rest[++i]:a.slice(eq+1);if(value===undefined)throw Error(`--${key} needs a value`);flags[key]=value;
 }
 return {command,flags,words};
}
const number=v=>v===undefined?undefined:Number(v);
// The To-do lists without the app: TERMINAI_TASKS_DIR and TERMINAI_TODO_DIR are set in every tab (src/main/todos.ts writes the files).
function todo(flags){
 const data=process.env.TERMINAI_TODO_DIR||join(homedir(),'Library/Application Support/clipwave-term'),json=file=>{try{return JSON.parse(readFileSync(file,'utf8'))}catch{return null}};
 const dir=process.env.TERMINAI_TASKS_DIR||join(data,'build-tasks','tasks');
 const user=(json(join(data,'prefs.json'))||{}).tasksUser;
 if(flags.mine&&!user)throw Error('Choose who you are in the TerminAI To-do sheet first');
 const open=t=>t&&typeof t==='object'&&(!flags.open||t.status!=='done');
 // Same rule as isMine in src/shared/types.ts.
 const keep=t=>open(t)&&(!flags.mine||t.assignee===user||t.assignee==='both'||(t.assignee===null&&t.createdBy===user));
 // The order the To-do sheet shows (rank in TodoSheet.tsx): `order` when set, else creation time, then id.
 const rank=t=>t.order??Date.parse(t.createdAt),byOrder=(a,b)=>rank(a)-rank(b)||(a.id<b.id?-1:a.id>b.id?1:0);
 // Where each image under a note is on disk, for a session that wants to look at it; and the tab of this Mac working on it.
 const known=user==='livio'||user==='ilai',working=(known&&json(join(data,`todos-working-${user}.json`)))||{};
 const withFiles=root=>t=>({...t,...(t.images?.length?{imageFiles:t.images.map(n=>join(root,t.id,n))}:{}),...(t.status==='doing'&&working[t.id]?{session:working[t.id].name}:{})});
 const out={};
 if(!flags.personal){let names=[];try{names=readdirSync(dir).filter(n=>n.endsWith('.json'))}catch{}out.shared=names.map(n=>json(join(dir,n))).filter(keep).sort(byOrder).map(withFiles(join(dir,'..','images')))}
 // Private tasks are one file per user, so all of them are the user's own. `list` is the name of the private list they are in
 // (todos-lists-<user>.json; no field: the first one); a deleted list waits a day for Undo and is left out.
 if(!flags.shared){
  const list=known?json(join(data,`todos-personal-${user}.json`)):null,pages=(known&&json(join(data,`todos-lists-${user}.json`)))||[];
  const page=id=>Array.isArray(pages)&&pages.find(p=>p&&p.id===(id||'private')),first=page('private')?.name||'Private';
  out.personal=(Array.isArray(list)?list:[]).filter(t=>open(t)&&!page(t.list)?.deletedAt).sort(byOrder).map(withFiles(join(data,'todo-images'))).map(t=>({...t,list:page(t.list)?.name||first}));
 }
 return out;
}
// The To-do as pages, the way the sheet shows them: `to` is what `terminai todo add --to` takes for each.
function map(){
 const data=process.env.TERMINAI_TODO_DIR||join(homedir(),'Library/Application Support/clipwave-term'),json=file=>{try{return JSON.parse(readFileSync(file,'utf8'))}catch{return null}};
 const user=(json(join(data,'prefs.json'))||{}).tasksUser;
 if(user!=='livio'&&user!=='ilai')throw Error('Choose who you are in the TerminAI To-do sheet first');
 const all=todo({open:true}),other=user==='livio'?'ilai':'livio',NAME={livio:'Matteo',ilai:'Ilai'};
 const short=({id,title,status,notes,product,session})=>({id,title,status,...(notes?{notes}:{}),...(product?{product}:{}),...(session?{session}:{})});
 const column=(page,to,assignee)=>({page,to,tasks:all.shared.filter(t=>t.assignee===assignee).map(short)});
 let pages=json(join(data,`todos-lists-${user}.json`));pages=(Array.isArray(pages)?pages:[]).filter(p=>p&&p.id&&typeof p.name==='string'&&!p.deletedAt);
 if(!pages.some(p=>p.id==='private'))pages.unshift({id:'private',name:'Private'});
 return {you:user,
  shared:[column(NAME[user],NAME[user].toLowerCase(),user),column('Together','together','both'),column(NAME[other],NAME[other].toLowerCase(),other),column('Unassigned','unassigned',null)],
  private:pages.map(p=>({page:p.name,to:p.name,about:p.about||null,tasks:all.personal.filter(t=>t.list===p.name).map(short)}))};
}
function request(command,flags,words){
 if(command==='task'){
  const action=words[0];
  if(action==='add')return {action,title:words.slice(1).join(' '),to:flags.to,note:flags.note};
  if(action==='about')return {action,list:words[1],text:words.slice(2).join(' ')};
  return {action,task:words.slice(1).join(' '),tab:process.env.TERMINAI_TAB_ID};
 }
 const id=words[0];if(command!=='list'&&command!=='open'&&!id)throw Error(`usage: terminai ${command} ${command==='show'?'<file>':'<id>'}`);
 if(command==='list')return {};
 if(command==='open')return {cwd:resolve(flags.cwd||process.cwd()),name:flags.name,group:flags.group,command:flags.command,background:!flags.foreground,cols:number(flags.cols),rows:number(flags.rows)};
 if(command==='send')return {id,text:words.slice(1).join(' '),enter:!flags['no-enter']};
 if(command==='read')return {id,lines:number(flags.lines)};
 if(command==='show')return {path:resolve(words.join(' '))};
 return {id};
}
async function main(){
 const {command,flags,words}=parse(process.argv.slice(2));
 if(!COMMANDS.includes(command))throw Error('usage: terminai list|open|send|read|close|focus|show|todo ...');
 if(command==='todo'&&words[0]==='map'){process.stdout.write(JSON.stringify(map(),null,1)+'\n');return}
 if(command==='todo'&&!WRITES.includes(words[0])){process.stdout.write(JSON.stringify(todo(flags),null,1)+'\n');return}
 if(command==='todo'&&!words[1])throw Error(words[0]==='add'?'usage: terminai todo add <title> --to <page> [--note <text>]':words[0]==='about'?'usage: terminai todo about <list> <text>':`usage: terminai todo ${words[0]} <task id or title>`);
 const wire=command==='todo'?'task':command,args=request(wire,flags,words);
 const file=process.env.TERMINAI_CONTROL||join(homedir(),'Library/Application Support/clipwave-term/control.json');
 let config;try{config=JSON.parse(readFileSync(file,'utf8'))}catch{throw Error(`TerminAI is not running (no ${file})`)}
 if(!Number.isInteger(config.port)||!/^[a-f0-9]{64}$/.test(config.token||''))throw Error(`Invalid ${file}`);
 const r=await fetch(`http://127.0.0.1:${config.port}/control`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+config.token},body:JSON.stringify({command:wire,args}),signal:AbortSignal.timeout(30000)})
  .catch(()=>{throw Error(`TerminAI is not answering (${file})`)});
 const data=await r.json().catch(()=>({}));
 if(!r.ok||data.error)throw Error(data.error||`HTTP ${r.status}`);
 process.stdout.write(JSON.stringify(data.result,null,1)+'\n');
}
main().catch(e=>{process.stderr.write(JSON.stringify({error:e.message})+'\n');process.exit(1)});
