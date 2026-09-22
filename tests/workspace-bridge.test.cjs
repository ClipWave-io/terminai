const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {buildSync}=require('esbuild');
const bundled=buildSync({entryPoints:[path.join(__dirname,'../src/main/workspace.ts')],bundle:true,platform:'node',format:'cjs',external:['electron'],write:false}).outputFiles[0].text;
async function harness(){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'terminai-auth-test-'));let encrypted=0;const calls=[];let route=()=>({});
 const module={exports:{}};const context={module,exports:module.exports,require:id=>id==='electron'?{app:{getPath:()=>dir},safeStorage:{isEncryptionAvailable:()=>true,encryptString:s=>{encrypted++;return Buffer.from(Buffer.from(s).toString('base64'))},decryptString:b=>Buffer.from(b.toString(),'base64').toString()}}:require(id),URL,AbortSignal,Buffer,fetch:async(url,opts)=>{calls.push({url,opts});const r=route(url,opts);return {ok:r.status===undefined||r.status<400,status:r.status||200,json:async()=>r.body??r}}};
 vm.runInNewContext(bundled,context);return {api:module.exports,dir,calls,setRoute:f=>route=f,encrypted:()=>encrypted};
}
test('HTTPS-only origins and narrow API routes prevent token forwarding',async()=>{
 const h=await harness();try{for(const url of ['http://localhost:3000','file:///tmp/a','https://x.test/path','https://u:p@x.test','https://x.test/?token=x'])assert.throws(()=>h.api.managerOrigin(url));
 assert.equal(h.api.managerOrigin('https://manager.test/'),'https://manager.test');
 for(const p of ['https://attacker.test','//attacker.test','/api/admin/users','/api/companies/a/../me'])await assert.rejects(h.api.workspaceRequest(p),/Unsupported/);assert.equal(h.calls.length,0);
 }finally{await fs.rm(h.dir,{recursive:true,force:true})}
});
test('login and invite keep desktop tokens encrypted in main; logout failures clear local session',async()=>{
 const h=await harness();const token='private-token-12345678901234567890';const identity={user:{id:'u',name:'User',email:'test@example.invalid'},companies:[]};
 h.setRoute((url)=>url.endsWith('/api/me')?identity:{token});
 try{const state=await h.api.workspaceLogin({url:'https://manager.test',email:'test@example.invalid',password:'password'});assert.equal(state.signedIn,true);assert(!JSON.stringify(state).includes(token));assert.equal(h.encrypted(),1);const file=await fs.readFile(path.join(h.dir,'workspace-session.enc'),'utf8');assert(!file.includes(token));assert.equal((await fs.stat(path.join(h.dir,'workspace-session.enc'))).mode&0o777,0o600);
 assert.equal(h.calls[0].opts.redirect,'error');assert.equal(h.calls[1].opts.headers.Authorization,`Bearer ${token}`);
 await h.api.workspaceLogin({url:'https://manager.test',password:'password',name:'Invited',inviteToken:'invite-secret'});assert(h.calls.some(c=>c.url.endsWith('/api/auth/accept-invite')));
 h.setRoute(()=>({status:503,body:{error:'offline'}}));await assert.rejects(h.api.workspaceLogout(),/offline/);assert.equal((await h.api.workspaceState()).signedIn,false);await assert.rejects(fs.stat(path.join(h.dir,'workspace-session.enc')));
 }finally{await fs.rm(h.dir,{recursive:true,force:true})}
});
test('failed login and expired session never report authenticated or expose bearer',async()=>{
 const h=await harness();try{h.setRoute(()=>({status:401,body:{error:'Invalid login'}}));await assert.rejects(h.api.workspaceLogin({url:'https://manager.test',password:'bad'}),/Invalid login/);assert.equal((await h.api.workspaceState()).signedIn,false);
 h.setRoute(url=>url.endsWith('/api/me')?{user:{id:'u'},companies:[]}:{token:'secret-token-12345678901234567890'});await h.api.workspaceLogin({url:'https://manager.test',password:'good'});
 h.setRoute(()=>({status:401,body:{error:'Expired'}}));await assert.rejects(h.api.workspaceRequest('/api/companies/c/catalog'),/Expired/);assert.equal((await h.api.workspaceState()).signedIn,false);
 }finally{await fs.rm(h.dir,{recursive:true,force:true})}
});
