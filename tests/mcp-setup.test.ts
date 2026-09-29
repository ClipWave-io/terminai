import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createMcpSetup } from '../src/main/mcp-setup'
function fixture(options: { servers?: any[]; absent?: string[]; credentials?: boolean; failure?: boolean; nodeVersions?: Record<string, string>; discardEnv?: boolean } = {}) {
  const calls: Array<{ command: string; args: string[] }> = []
  const servers = options.servers || []
  const setup = createMcpSetup({ home: '/test', env: { PATH: '/usr/bin' },
    executable: async path => !(options.absent || []).some(n => path.endsWith('/' + n)) && (!path.endsWith('/node') || !options.nodeVersions || path in options.nodeVersions),
    exists: async () => options.credentials ?? false,
    run: async (command, args) => {
      calls.push({ command, args })
      if (options.failure) throw new Error('SECRET-do-not-return')
      if (args[0] === '--version') return options.nodeVersions?.[command] || 'v22.12.0'
      if (args[1] === 'list') return JSON.stringify(servers)
      assert.deepEqual(args.slice(0, 2), ['mcp', 'add'])
      const separator = args.indexOf('--')
      const env = args.includes('--env') && !options.discardEnv ? { PATH: args[args.indexOf('--env') + 1].slice(5) } : {}
      servers.push({ name: args[2], enabled: true, transport: { command: args[separator + 1], args: args.slice(separator + 2), env } })
      return ''
    },
  })
  return { setup, calls }
}
test('only fixed allowlist commands are registered, duplicate requests are idempotent', async () => {
  const f = fixture()
  const results = await f.setup(['chrome-devtools', 'chrome-devtools', '$(touch /tmp/unsafe)'])
  assert.equal(results.find(r => r.id === 'chrome-devtools')?.status, 'configured')
  assert.equal(results.find(r => r.id.startsWith('$'))?.status, 'error')
  await f.setup(['chrome-devtools'])
  const adds = f.calls.filter(c => c.args[1] === 'add')
  assert.equal(adds.length, 1)
  assert.deepEqual(adds[0].args, ['mcp', 'add', 'terminai-chrome', '--env', 'PATH=/test/.npm-global/bin:/test/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin', '--', '/test/.npm-global/bin/npx', '-y', 'chrome-devtools-mcp@1.9.0', '--isolated', '--no-usage-statistics'])
})
test('Google registers pinned official package but reports missing personal credentials', async () => {
  const f = fixture()
  const [r] = await f.setup(['google-ads'])
  assert.equal(r.status, 'needs-setup')
  assert.match(r.message, /own Google Application Default Credentials/)
  const add = f.calls.find(c => c.args[1] === 'add')!
  assert.match(add.args.join(' '), /googleads\/google-ads-mcp.git@0b78c0caa6d1dfbd21817487c7e571514c627c87/)
  assert.equal(add.args.includes('--env'), false)
})
test('preserves existing servers and does not delete unassigned ones', async () => {
  const f = fixture({ servers: [{ name: 'chrome', enabled: true, transport: { command: 'npx', args: ['chrome-devtools-mcp@1.8.0'] } }, { name: 'unrelated' }] })
  assert.equal((await f.setup(['chrome-devtools']))[0].status, 'configured')
  await f.setup([])
  assert.equal(f.calls.some(c => c.args[1] === 'add' || c.args[1] === 'remove'), false)
})
test('does not overwrite conflicting managed names or silently enable disabled servers', async () => {
  for (const server of [{ name: 'terminai-chrome', transport: { command: 'different' } }, { name: 'chrome', enabled: false }]) {
    const f = fixture({ servers: [server] })
    assert.equal((await f.setup(['chrome-devtools']))[0].status, 'needs-setup')
    assert.equal(f.calls.some(c => c.args[1] === 'add'), false)
  }
})
test('missing dependencies return actionable setup states without fake success', async () => {
  for (const absent of ['codex', 'npx', 'node']) {
    assert.equal((await fixture({ absent: [absent] }).setup(['chrome-devtools']))[0].status, 'needs-setup')
  }
  assert.equal((await fixture({ absent: ['pipx'] }).setup(['google-ads']))[0].status, 'needs-setup')
})
test('failures never expose subprocess output or credentials', async () => {
  const result = await fixture({ failure: true }).setup(['chrome-devtools'])
  assert.equal(result[0].status, 'error')
  assert.equal(JSON.stringify(result).includes('SECRET'), false)
})
test('concurrent setup calls are serialized and do not double-register', async () => {
  const f = fixture()
  await Promise.all([f.setup(['chrome-devtools']), f.setup(['chrome-devtools'])])
  assert.equal(f.calls.filter(c => c.args[1] === 'add').length, 1)
})

test('selects supported Node later in candidate list and pins its directory first for npx', async () => {
  const f = fixture({ nodeVersions: { '/opt/homebrew/bin/node': 'v21.6.1', '/usr/local/bin/node': 'v22.13.1' } })
  assert.equal((await f.setup(['chrome-devtools']))[0].status, 'configured')
  const add = f.calls.find(c => c.args[1] === 'add')!
  assert.equal(add.args[add.args.indexOf('--env') + 1], 'PATH=/usr/local/bin:/test/.npm-global/bin:/test/.local/bin:/opt/homebrew/bin:/usr/bin:/bin')
  assert.equal((await f.setup(['chrome-devtools']))[0].status, 'configured')
  assert.equal(f.calls.filter(c => c.args[1] === 'add').length, 1)
})
test('22.11 does not meet the minimum, 22.12 and newer do', async () => {
  for (const version of ['v20.20.0', 'v21.6.1', 'v22.11.0', 'v22.12.0-nightly']) {
    const f = fixture({ nodeVersions: { '/usr/bin/node': version } })
    assert.equal((await f.setup(['chrome-devtools']))[0].status, 'needs-setup')
    assert.equal(f.calls.some(c => c.args[1] === 'add'), false)
  }
  assert.equal((await fixture({ nodeVersions: { '/usr/bin/node': 'v24.0.0' } }).setup(['chrome-devtools']))[0].status, 'configured')
})
test('does not report success if Codex did not persist the selected runtime PATH', async () => {
  assert.equal((await fixture({ discardEnv: true }).setup(['chrome-devtools']))[0].status, 'error')
})
test('preserves managed configuration with missing or old-node-first PATH and asks for repair', async () => {
  for (const env of [{}, { PATH: '/opt/homebrew/bin:/usr/local/bin' }]) {
    const f = fixture({ nodeVersions: { '/opt/homebrew/bin/node': 'v21.6.1', '/usr/local/bin/node': 'v22.13.1' }, servers: [{ name: 'terminai-chrome', transport: { command: 'npx', args: ['-y', 'chrome-devtools-mcp@1.9.0', '--isolated', '--no-usage-statistics'], env } }] })
    assert.equal((await f.setup(['chrome-devtools']))[0].status, 'needs-setup')
    assert.equal(f.calls.some(c => c.args[1] === 'add'), false)
  }
})

test('Claude registers user-scoped MCPs without Codex and verifies persistence',async()=>{
 const config:any={mcpServers:{personal:{command:'untouched'}}},calls:any[]=[]
 const setup=createMcpSetup({home:'/test',env:{PATH:'/usr/bin'},exists:async()=>true,executable:async path=>!path.endsWith('/codex'),readText:async()=>JSON.stringify(config),run:async(command,args)=>{
  if(args[0]==='--version')return 'v22.13.1'
  calls.push({command,args});assert.ok(command.endsWith('/claude'));assert.deepEqual(args.slice(0,4),['mcp','add-json','--scope','user']);config.mcpServers[args[4]]=JSON.parse(args[5]);return ''
 }},'claude')
 const results=await setup(['chrome-devtools','google-ads']);assert.ok(results.every(r=>r.status==='configured'&&r.client==='claude'));assert.equal(calls.length,2)
 assert.equal(config.mcpServers.personal.command,'untouched');assert.match(config.mcpServers['terminai-chrome'].env.PATH,/^\/test\//)
 await setup(['chrome-devtools','google-ads']);assert.equal(calls.length,2)
 config.mcpServers['terminai-chrome'].command='user-edit';assert.equal((await setup(['chrome-devtools']))[0].status,'needs-setup');assert.equal(calls.length,2)
})
test('Claude invalid settings and CLI failures do not expose secrets or report success',async()=>{
 for(const corrupt of [true,false]){
  const setup=createMcpSetup({home:'/test',env:{},exists:async()=>true,executable:async()=>true,readText:async()=>corrupt?'{broken':'{}',run:async(_c,args)=>{if(args[0]==='--version')return 'v22.13.1';throw Error('SECRET')}},'claude')
  const [result]=await setup(['chrome-devtools']);assert.equal(result.status,'error');assert.ok(!result.message.includes('SECRET'));assert.match(result.message,/Claude Code/)
 }
})
