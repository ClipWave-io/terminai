import {createServer} from 'node:http'
import {randomBytes,timingSafeEqual} from 'node:crypto'
import {mkdirSync,writeFileSync,readFileSync,renameSync,unlinkSync,chmodSync} from 'node:fs'
import {join,dirname} from 'node:path'

/** Local MCP transport. The credential never enters renderer or remote page content. */
export async function startBrowserBridge(directory:string,execute:(command:string,args:any,owner:string)=>Promise<unknown>) {
  mkdirSync(directory,{recursive:true})
  const token=randomBytes(32).toString('hex'), file=join(directory,'browser-bridge.json')
  const server=createServer(async(req,res)=>{
    res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store')
    const provided=req.headers.authorization?.replace(/^Bearer /,'')||''
    const authorized=/^[a-f0-9]{64}$/.test(provided)&&timingSafeEqual(Buffer.from(provided),Buffer.from(token))
    if(!authorized||req.headers.origin||req.headers['sec-fetch-site']){res.writeHead(403);res.end('{"error":"Forbidden"}');return}
    if(req.method!=='POST'||req.url!=='/browser'){res.writeHead(404);res.end('{}');return}
    try {
      let body=''
      for await(const part of req){body+=part;if(Buffer.byteLength(body)>100000)throw Error('Request too large')}
      const input=JSON.parse(body)
      if(!['list','open','navigate','snapshot','click','type','screenshot'].includes(input.command)||typeof input.owner!=='string'||!/^[a-zA-Z0-9-]{1,120}$/.test(input.owner))throw Error('Invalid browser request')
      const result=await execute(input.command,input.args||{},input.owner)
      res.end(JSON.stringify({result}))
    }catch(e){res.writeHead(400);res.end(JSON.stringify({error:e instanceof Error?e.message:'Browser request failed'}))}
  })
  server.requestTimeout=30000;server.headersTimeout=10000
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)})
  const port=(server.address() as {port:number}).port
  writeFileSync(file+'.tmp',JSON.stringify({port,token}),{mode:0o600});chmodSync(file+'.tmp',0o600);renameSync(file+'.tmp',file)
  return {port,close:()=>{server.close();try{if(JSON.parse(readFileSync(file,'utf8')).token===token)unlinkSync(file)}catch{}}}
}

/** A dedicated managed section; existing user-owned MCP entries are never replaced. */
export function registerBrowserMcp(configFile:string,executable:string,script:string,descriptor:string) {
  mkdirSync(dirname(configFile),{recursive:true})
  let original='';try{original=readFileSync(configFile,'utf8')}catch(e:any){if(e.code!=='ENOENT')throw e}
  const start='# BEGIN TERMINAI EMBEDDED BROWSER',end='# END TERMINAI EMBEDDED BROWSER'
  const first=original.indexOf(start),last=original.indexOf(end)
  if(first<0&&/\[mcp_servers\.(?:terminai_browser|"terminai_browser")\]/.test(original))return false
  if((first>=0)!==(last>=0)||last<first)throw Error('Incomplete TerminAI MCP configuration')
  const section=[start,'[mcp_servers.terminai_browser]',`command = ${JSON.stringify(executable)}`,`args = ${JSON.stringify([script,descriptor])}`,
    'env = { ELECTRON_RUN_AS_NODE = "1" }','env_vars = ["TERMINAI_WORKSPACE_ID"]','startup_timeout_sec = 15',end].join('\n')
  const updated=first>=0?original.slice(0,first)+section+original.slice(last+end.length):original+'\n'+section+'\n'
  let current='';try{current=readFileSync(configFile,'utf8')}catch(e:any){if(e.code!=='ENOENT')throw e}
  if(current!==original)throw Error('Codex configuration changed; retry setup')
  if(updated!==original){writeFileSync(configFile+'.terminai-tmp',updated,{mode:0o600});chmodSync(configFile+'.terminai-tmp',0o600);renameSync(configFile+'.terminai-tmp',configFile)}
  return true
}

/** Claude uses JSON for user-scoped stdio MCPs. Preserve every user-owned entry. */
export function registerClaudeBrowserMcp(configFile:string,executable:string,script:string,descriptor:string) {
  mkdirSync(dirname(configFile),{recursive:true})
  let original='';try{original=readFileSync(configFile,'utf8')}catch(e:any){if(e.code!=='ENOENT')throw e}
  const config=original?JSON.parse(original):{}
  if(!config||typeof config!=='object'||Array.isArray(config))throw Error('Invalid Claude configuration')
  if(config.mcpServers!==undefined&&(!config.mcpServers||typeof config.mcpServers!=='object'||Array.isArray(config.mcpServers)))throw Error('Invalid Claude MCP configuration')
  const desired={type:'stdio',command:executable,args:[script,descriptor],env:{ELECTRON_RUN_AS_NODE:'1',TERMINAI_WORKSPACE_ID:'${TERMINAI_WORKSPACE_ID:-}'}}
  const existing=config.mcpServers?.terminai_browser, ownershipFile=configFile+'.terminai-browser.json'
  if(existing!==undefined){
    if(JSON.stringify(existing)===JSON.stringify(desired))return true
    // Only update a definition that is byte-equivalent to the one we last wrote.
    // A user edit or an unrecognized entry always wins over managed registration.
    let owned:unknown;try{owned=JSON.parse(readFileSync(ownershipFile,'utf8'))}catch{return false}
    if(JSON.stringify(existing)!==JSON.stringify(owned))return false
  }
  config.mcpServers={...config.mcpServers,terminai_browser:desired}
  let current='';try{current=readFileSync(configFile,'utf8')}catch(e:any){if(e.code!=='ENOENT')throw e}
  if(current!==original)throw Error('Claude configuration changed; retry setup')
  writeFileSync(configFile+'.terminai-tmp',JSON.stringify(config,null,2)+'\n',{mode:0o600});chmodSync(configFile+'.terminai-tmp',0o600);renameSync(configFile+'.terminai-tmp',configFile)
  writeFileSync(ownershipFile+'.tmp',JSON.stringify(desired),{mode:0o600});chmodSync(ownershipFile+'.tmp',0o600);renameSync(ownershipFile+'.tmp',ownershipFile)
  return true
}
