#!/usr/bin/env node
// Dependency-free client for TerminAI's local tab control channel (src/main/control.ts).
//   terminai list
//   terminai open --cwd <dir> [--name <n>] [--group <g>] [--foreground] [--cols N --rows N] [--command '<shell line>' | -- <argv...>]
//   terminai send <id> <text...> [--no-enter]
//   terminai read <id> [--lines N]
//   terminai close <id>
//   terminai focus <id>
//   terminai todo [--shared|--personal] [--open] [--mine]   read-only, straight from the files
// Drives the instance named by TERMINAI_CONTROL (set in every TerminAI tab), else the installed app. Prints JSON.
const {readFileSync,readdirSync}=require('node:fs'),{join,resolve}=require('node:path'),{homedir}=require('node:os');
const COMMANDS=['list','open','send','read','close','focus','todo'],SWITCHES=['foreground','no-enter','shared','personal','open','mine'];
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
 const out={};
 if(!flags.personal){let names=[];try{names=readdirSync(dir).filter(n=>n.endsWith('.json'))}catch{}out.shared=names.map(n=>json(join(dir,n))).filter(keep)}
 // Private tasks are one file per user, so all of them are the user's own.
 if(!flags.shared){const list=user==='livio'||user==='ilai'?json(join(data,`todos-personal-${user}.json`)):null;out.personal=(Array.isArray(list)?list:[]).filter(open)}
 return out;
}
function request(command,flags,words){
 const id=words[0];if(command!=='list'&&command!=='open'&&!id)throw Error(`usage: terminai ${command} <id>`);
 if(command==='list')return {};
 if(command==='open')return {cwd:resolve(flags.cwd||process.cwd()),name:flags.name,group:flags.group,command:flags.command,background:!flags.foreground,cols:number(flags.cols),rows:number(flags.rows)};
 if(command==='send')return {id,text:words.slice(1).join(' '),enter:!flags['no-enter']};
 if(command==='read')return {id,lines:number(flags.lines)};
 return {id};
}
async function main(){
 const {command,flags,words}=parse(process.argv.slice(2));
 if(!COMMANDS.includes(command))throw Error('usage: terminai list|open|send|read|close|focus|todo ...');
 if(command==='todo'){process.stdout.write(JSON.stringify(todo(flags),null,1)+'\n');return}
 const args=request(command,flags,words);
 const file=process.env.TERMINAI_CONTROL||join(homedir(),'Library/Application Support/clipwave-term/control.json');
 let config;try{config=JSON.parse(readFileSync(file,'utf8'))}catch{throw Error(`TerminAI is not running (no ${file})`)}
 if(!Number.isInteger(config.port)||!/^[a-f0-9]{64}$/.test(config.token||''))throw Error(`Invalid ${file}`);
 const r=await fetch(`http://127.0.0.1:${config.port}/control`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+config.token},body:JSON.stringify({command,args}),signal:AbortSignal.timeout(30000)})
  .catch(()=>{throw Error(`TerminAI is not answering (${file})`)});
 const data=await r.json().catch(()=>({}));
 if(!r.ok||data.error)throw Error(data.error||`HTTP ${r.status}`);
 process.stdout.write(JSON.stringify(data.result,null,1)+'\n');
}
main().catch(e=>{process.stderr.write(JSON.stringify({error:e.message})+'\n');process.exit(1)});
