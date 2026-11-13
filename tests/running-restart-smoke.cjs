// A restart (an update included) starts again every conversation that was running, not only the open tab: two
// Codex stand-ins run in two tabs, a third tab is open; after the restart both conversations are running again.
const fs=require('fs'),os=require('os'),path=require('path'),cp=require('child_process'),assert=require('assert/strict');
if(!process.versions.electron){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'terminai-running-restart-')),home=path.join(root,'codex-home'),bin=path.join(root,'bin');fs.mkdirSync(bin);fs.mkdirSync(path.join(home,'thread-writer-locks'),{recursive:true});
 const id='12345678-1234-4234-8234-123456789abc',id2='87654321-4321-4321-8321-cba987654321';
 fs.writeFileSync(path.join(root,'codex.c'),`#include <stdio.h>\n#include <stdlib.h>\n#include <unistd.h>\n#include <fcntl.h>\nint main(int argc,char **argv){char lock[4096];snprintf(lock,sizeof(lock),"%s/thread-writer-locks/%s.lock",getenv("CODEX_HOME"),getenv("TEST_THREAD_ID"));int fd=open(lock,O_CREAT|O_RDWR,0600);FILE*f=fopen(getenv("TEST_ARGS_LOG"),"a");for(int i=1;i<argc;i++)fprintf(f,"%s\\n",argv[i]);fprintf(f,"END\\n");fclose(f);puts("Local Codex stand-in ready");fflush(stdout);while(1)sleep(1);return fd;}`);
 cp.execFileSync('/usr/bin/clang',[path.join(root,'codex.c'),'-o',path.join(bin,'codex')]);
 const shell=path.join(bin,'test-shell');fs.writeFileSync(shell,'#!/bin/sh\nif [ "$1" = "-ilc" ]; then exec /bin/zsh -dfc "$2"; fi\nexec /bin/zsh -df\n',{mode:0o755});
 const env={...process.env,CODEX_HOME:home,SHELL:shell,PATH:bin+':'+process.env.PATH,TEST_ROOT:root,TEST_THREAD_ID:id,TEST_THREAD_ID2:id2,TEST_ARGS_LOG:path.join(root,'args.log')};
 const electron=path.resolve('node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');
 for(const phase of ['first','restart']){cp.execFileSync(electron,[__filename],{env:{...env,TEST_PHASE:phase},stdio:'inherit',timeout:50000});if(process.env.DEBUG)console.log(phase,JSON.stringify(JSON.parse(fs.readFileSync(path.join(root,'profile','prefs.json'),'utf8')).tabs.map(t=>({a:t.agent,s:t.agentSession,w:t.wasAlive,ww:t.wasWorking}))))}
 const runs=fs.readFileSync(env.TEST_ARGS_LOG,'utf8').trim().split('END\n').filter(Boolean);assert.equal(runs.length,4,`two conversations before and two after the restart: ${runs.length}`);
 console.log('PASS restart: both running conversations started again, not only the open tab');
}else{
 const {app}=require('electron'),root=process.env.TEST_ROOT,profile=path.join(root,'profile'),phase=process.env.TEST_PHASE;app.setPath('userData',profile);fs.mkdirSync(profile,{recursive:true});
 if(phase==='first')fs.writeFileSync(path.join(profile,'prefs.json'),JSON.stringify({seenWelcome:true,tabs:[],voice:{enabled:false},newTabAgent:'none'}));
 const delay=ms=>new Promise(r=>setTimeout(r,ms));
 app.on('browser-window-created',(_e,win)=>win.webContents.once('did-finish-load',()=>{void(async()=>{
   await delay(1800);
   const js=c=>win.webContents.executeJavaScript(c);
   if(phase==='first'){
    // Two tabs running Codex, then a third plain tab, open in front.
    await js(`(async()=>{const t=await window.term.pty.list();window.term.pty.write(t[0].id,'codex resume ${process.env.TEST_THREAD_ID} --model one\\r')})()`);
    const first=await js(`window.term.pty.list().then(t=>t.map(x=>x.id))`);
    await js(`document.querySelector('.rail-actions .btn.primary')?.click()`);await delay(1500);
    // The tab just opened (whatever order the list comes in).
    await js(`(async()=>{const t=await window.term.pty.list(),fresh=t.find(x=>!${JSON.stringify(first)}.includes(x.id));window.term.pty.write(fresh.id,'codex resume ${process.env.TEST_THREAD_ID2} --model two\\r')})()`);
    await delay(2500);
    await js(`document.querySelector('.rail-actions .btn.primary')?.click()`);await delay(2500);
    // The window notices each agent within a few seconds and saves it.
    const codexTabs=()=>JSON.parse(fs.readFileSync(path.join(profile,'prefs.json'),'utf8')).tabs.filter(t=>t.agent==='codex').length;
    for(let n=0;n<100&&codexTabs()<2;n++)await delay(250);
    assert.equal(codexTabs(),2,'two Codex tabs saved');
   }else{
    // Both conversations come back by themselves, one every 3 s.
    for(let n=0;n<80&&fs.readFileSync(process.env.TEST_ARGS_LOG,'utf8').split('END').length<5;n++)await delay(250);
    if(process.env.DEBUG)console.log('LIST',await js(`(async()=>JSON.stringify((await window.term.pty.list()).map(t=>[t.id,t.cwd])))()`),await js(`document.querySelector('.term-host.active .xterm-rows')?.textContent.slice(0,300)`));
   }
   app.quit();
 })().catch(e=>{console.error(e);app.exit(1)})}));
 setTimeout(()=>app.exit(1),40000).unref();require('../out/main/index.js');
}
