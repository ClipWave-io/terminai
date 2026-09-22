// Runs two real Electron app processes against an isolated profile and a local
// Codex stand-in. No user sessions, credentials, network or model calls involved.
const fs=require('fs'),os=require('os'),path=require('path'),cp=require('child_process'),assert=require('assert/strict');
if(!process.versions.electron){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'terminai-codex-restart-')),home=path.join(root,'codex-home'),bin=path.join(root,'bin');fs.mkdirSync(bin);fs.mkdirSync(path.join(home,'thread-writer-locks'),{recursive:true});
 const id='12345678-1234-4234-8234-123456789abc';
 fs.writeFileSync(path.join(root,'codex.c'),`#include <stdio.h>\n#include <stdlib.h>\n#include <unistd.h>\n#include <fcntl.h>\nint main(int argc,char **argv){char lock[4096];snprintf(lock,sizeof(lock),"%s/thread-writer-locks/%s.lock",getenv("CODEX_HOME"),getenv("TEST_THREAD_ID"));int fd=open(lock,O_CREAT|O_RDWR,0600);FILE*f=fopen(getenv("TEST_ARGS_LOG"),"a");for(int i=1;i<argc;i++)fprintf(f,"%s\\n",argv[i]);fprintf(f,"END\\n");fclose(f);puts("Local Codex stand-in ready");fflush(stdout);while(1)sleep(1);return fd;}`);
 cp.execFileSync('/usr/bin/clang',[path.join(root,'codex.c'),'-o',path.join(bin,'codex')]);
 const shell=path.join(bin,'test-shell');fs.writeFileSync(shell,'#!/bin/sh\nif [ "$1" = "-ilc" ]; then exec /bin/zsh -dfc "$2"; fi\nexec /bin/zsh -df\n',{mode:0o755});
 const env={...process.env,CODEX_HOME:home,SHELL:shell,PATH:bin+':'+process.env.PATH,TEST_ROOT:root,TEST_THREAD_ID:id,TEST_ARGS_LOG:path.join(root,'args.log')};
 const electron=path.resolve('node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');
 for(const phase of ['first','restart'])cp.execFileSync(electron,[__filename],{env:{...env,TEST_PHASE:phase},stdio:'inherit',timeout:50000});
 const lines=fs.readFileSync(env.TEST_ARGS_LOG,'utf8').trim().split('END\n');assert.match(lines[1],new RegExp('resume\\n'+id));assert.match(lines[1],/--model\nrestart-test/);assert.equal(lines.length,2);
 console.log('PASS real app restart: detects Codex process/thread, persists exact ID/options, relaunches same thread without local rollout file');
}else{
 const {app}=require('electron'),root=process.env.TEST_ROOT,profile=path.join(root,'profile'),phase=process.env.TEST_PHASE;app.setPath('userData',profile);fs.mkdirSync(profile,{recursive:true});
 if(phase==='first')fs.writeFileSync(path.join(profile,'prefs.json'),JSON.stringify({seenWelcome:true,tabs:[],voice:{enabled:false}}));
 const delay=ms=>new Promise(r=>setTimeout(r,ms));
 app.on('browser-window-created',(_e,win)=>win.webContents.once('did-finish-load',()=>{void(async()=>{
   await delay(1800);
   if(phase==='first')await win.webContents.executeJavaScript(`(async()=>{const tabs=await window.term.pty.list();window.term.pty.write(tabs[0].id,'codex resume ${process.env.TEST_THREAD_ID} --model restart-test\\r')})()`);
   let okay=false;
   for(let n=0;n<100;n++){await delay(250);const prefs=JSON.parse(fs.readFileSync(path.join(profile,'prefs.json'),'utf8'));const t=prefs.tabs[0];if(t?.agent==='codex'&&t.agentSession===process.env.TEST_THREAD_ID&&fs.existsSync(process.env.TEST_ARGS_LOG)){const txt=fs.readFileSync(process.env.TEST_ARGS_LOG,'utf8');if(phase==='first'||txt.includes('resume\n'+process.env.TEST_THREAD_ID)){okay=true;break}}}
   assert.ok(okay,phase+' failed to detect/restore exact Codex thread');app.quit();
 })().catch(e=>{console.error(e);app.exit(1)})}));
 setTimeout(()=>app.exit(1),40000).unref();require('../out/main/index.js');
}
