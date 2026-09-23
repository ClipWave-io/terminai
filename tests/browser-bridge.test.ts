import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,readFileSync,writeFileSync,statSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {spawn} from 'node:child_process'
import {startBrowserBridge,registerBrowserMcp} from '../src/main/browser-bridge'

test('bridge rejects browser origins/bad tokens and MCP binds the session',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'terminai-bridge-test-'));const calls:any[]=[]
 const bridge=await startBrowserBridge(dir,async(...args)=>{calls.push(args);return[{id:'test-tab'}]})
 try{
  const file=join(dir,'browser-bridge.json'),saved=JSON.parse(readFileSync(file,'utf8')),url=`http://127.0.0.1:${bridge.port}/browser`
  assert.equal(statSync(file).mode&0o777,0o600)
  assert.equal((await fetch(url,{method:'POST',body:'{}'})).status,403)
  assert.equal((await fetch(url,{method:'POST',headers:{Authorization:'Bearer '+'é'.repeat(64)},body:'{}'})).status,403)
  assert.equal((await fetch(url,{method:'POST',headers:{Authorization:'Bearer '+saved.token,Origin:'https://example.com'},body:'{}'})).status,403)
  const lines=[{jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-03-26'}},{jsonrpc:'2.0',id:2,method:'tools/list'},{jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'browser_list',arguments:{}}}]
  const output=await new Promise<string>((resolve,reject)=>{const child=spawn(process.execPath,[join(process.cwd(),'resources/browser-mcp.cjs'),file],{env:{...process.env,TERMINAI_WORKSPACE_ID:'session-one'}});let out='';child.stdout.on('data',v=>out+=v);child.on('error',reject);child.on('close',code=>code?reject(Error('MCP exited '+code)):resolve(out));child.stdin.end(lines.map(v=>JSON.stringify(v)).join('\n')+'\n')})
  const responses=output.trim().split('\n').map(s=>JSON.parse(s));assert.equal(responses.length,3);assert.equal(responses[1].result.tools.length,7);assert.match(responses[2].result.content[0].text,/test-tab/);assert.deepEqual(calls,[['list',{},'session-one']])
 }finally{bridge.close()}
})
test('MCP registration preserves other settings and refuses user-owned entry',()=>{
 const dir=mkdtempSync(join(tmpdir(),'terminai-config-test-')),file=join(dir,'config.toml');writeFileSync(file,'model = "unchanged"\n')
 assert.equal(registerBrowserMcp(file,'/app/Electron','/app/browser.cjs','/private/bridge.json'),true)
 const first=readFileSync(file,'utf8');assert.match(first,/env_vars = \["TERMINAI_WORKSPACE_ID"\]/);assert.ok(first.startsWith('model = "unchanged"'))
 registerBrowserMcp(file,'/app/Electron','/app/browser.cjs','/private/bridge.json');assert.equal(readFileSync(file,'utf8'),first)
 writeFileSync(file,'[mcp_servers.terminai_browser]\ncommand = "user-owned"\n');assert.equal(registerBrowserMcp(file,'x','y','z'),false);assert.match(readFileSync(file,'utf8'),/user-owned/)
})
