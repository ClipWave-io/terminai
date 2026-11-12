// Off the record: a failed deletion of the server copy is tried again. Run: node offdelete.test.cjs <repo root>
const root = process.argv[2], esbuild = require(root + '/node_modules/esbuild'), path = require('path')
const stub = { name: 'stub', setup(b) {
  b.onResolve({ filter: /^\.\/(pty|store|workspace)$/ }, a => ({ path: a.path, namespace: 'stub' }))
  b.onLoad({ filter: /.*/, namespace: 'stub' }, a => ({ loader: 'js', contents: a.path === './pty' ? 'module.exports=globalThis.__pty' : a.path === './workspace' ? 'module.exports={teamUpload:async()=>({})}' : 'module.exports={load:()=>globalThis.__prefs,save:(x)=>(globalThis.__prefs={...globalThis.__prefs,...x})}' })) } }
;(async () => {
  globalThis.__prefs = { tabModes: { K: 'off' }, tabSharing: {}, folderSharing: {}, sessionTabs: {}, shareConversations: false }
  globalThis.__pty = { liveIds: () => ['T'], workspaceKeyOf: () => 'K', cwdOf: () => '/x', agentOf: () => ({ kind: 'claude', alive: true, sessionId: '', args: [] }), statusOf: () => 'waiting', atShellPrompt: () => false, write: () => {}, written: async () => {} }
  const r = await esbuild.build({ entryPoints: [path.join(root, 'src/main/teambridge.ts')], bundle: true, platform: 'node', format: 'cjs', write: false, plugins: [stub], external: ['electron'], logLevel: 'silent' })
  const m = { exports: {} }; new Function('module', 'exports', 'require', r.outputFiles[0].text)(m, m.exports, require)
  const calls = []; let failDelete = true
  const team = { id: 'C', call: async (p, method = 'GET') => { calls.push(method); if (method === 'DELETE' && failDelete) throw new Error('network'); if (method === 'PUT') return { conversation: { id: 'conv' } }; return {} } }
  const bridge = m.exports.createBridge({ team: async () => team, tabName: () => 'Tab', notify: () => {} })
  const real = Date.now; let skew = 0; Date.now = () => real() + skew
  const step = async (label) => { const before = calls.length; await bridge.tick(); const did = calls.slice(before).join('+') || 'nothing'; console.log(label.padEnd(46), did); return did }
  const a = await step('tick 1, server refuses the deletion:')
  const b = await step('tick 2, five seconds later:')
  skew = 61_000; failDelete = false
  const c = await step('tick 3, a minute later, server is back:')
  const d = await step('tick 4:')
  const ok = a === 'PUT+DELETE' && b === 'nothing' && c === 'PUT+DELETE' && d === 'nothing'
  console.log(ok ? 'RESULT PASS' : 'RESULT FAIL'); process.exit(ok ? 0 : 1)
})()
