import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createMcpSetup } from '../src/main/mcp-setup'
function fixture(options: { servers?: any[]; absent?: string[]; credentials?: boolean; failure?: boolean } = {}) {
  const calls: Array<{ command: string; args: string[] }> = []
  const servers = options.servers || []
  const setup = createMcpSetup({ home: '/test', env: { PATH: '/usr/bin' },
    executable: async path => !(options.absent || []).some(n => path.endsWith('/' + n)),
    exists: async () => options.credentials ?? false,
    run: async (command, args) => {
      calls.push({ command, args })
      if (options.failure) throw new Error('SECRET-do-not-return')
      if (args[0] === '--version') return 'v22.12.0'
      if (args[1] === 'list') return JSON.stringify(servers)
      assert.deepEqual(args.slice(0, 2), ['mcp', 'add'])
      servers.push({ name: args[2], enabled: true, transport: { command: args[4], args: args.slice(5) } })
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
  assert.deepEqual(adds[0].args, ['mcp', 'add', 'terminai-chrome', '--', '/test/.npm-global/bin/npx', '-y', 'chrome-devtools-mcp@1.9.0', '--isolated', '--no-usage-statistics'])
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
