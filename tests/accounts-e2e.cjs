// End to end for Claude accounts (src/main/accounts.ts): the relay against a fake Anthropic, with fake
// tokens, then a fake claude in a real tab for the shim and the menu.
// After `npx electron-vite build`: CODEX_HOME=<scratch dir> TERMINAI_TEST_BUILD=1 npx electron tests/accounts-e2e.cjs
// It adds two fake items to the login keychain and removes them.
const { app } = require('electron'), fs = require('fs'), os = require('os'), path = require('path'), http = require('http'), assert = require('assert/strict')
const { execFileSync, execFile } = require('child_process'), crypto = require('crypto')
if (!process.env.CODEX_HOME) { console.error('Set CODEX_HOME to a scratch folder: the app writes its Codex config there.'); process.exit(1) }
const REPO = path.join(__dirname, '..'), WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'terminai-accounts-e2e-'))
const dir = path.join(WORK, 'userData'); fs.mkdirSync(dir); app.setPath('userData', dir)
fs.writeFileSync(path.join(dir, 'prefs.json'), JSON.stringify({ seenWelcome: true, tabs: [], voice: { enabled: false } }))
const SVC = 'TerminAI Claude account', A = crypto.randomUUID(), B = crypto.randomUUID()
const LOGIN = 'sk-ant-oat01-FAKELOGINFORTESTONLY-LLLLLL'
const tok = { [A]: 'sk-ant-oat01-FAKETOKENFORTESTONLY-AAAAAA', [B]: 'sk-ant-oat01-FAKETOKENFORTESTONLY-BBBBBB' }
const who = auth => auth === `Bearer ${LOGIN}` ? 'login' : auth === `Bearer ${tok[A]}` ? 'A' : auth === `Bearer ${tok[B]}` ? 'B' : `other:${String(auth).slice(0, 20)}`
for (const id of [A, B]) execFileSync('/usr/bin/security', ['add-generic-password', '-U', '-s', SVC, '-a', id, '-l', 'TerminAI e2e', '-w', tok[id]])
fs.mkdirSync(path.join(dir, 'accounts', 'tabs'), { recursive: true })
fs.writeFileSync(path.join(dir, 'accounts', 'accounts.json'), JSON.stringify({ mode: 'auto', accounts: [{ id: A, label: 'Alpha', fp: 'x', addedAt: 0 }, { id: B, label: 'Beta', fp: 'y', addedAt: 0 }], exhausted: {} }))
// The login's usage as statusline.sh caches it from /api/oauth/usage.
const LOGIN_USAGE = path.join(WORK, 'usage-limits.json')
fs.writeFileSync(LOGIN_USAGE, JSON.stringify({ limits: [{ kind: 'session', percent: 19, resets_at: '2030-01-01T10:00:00+00:00' }, { kind: 'weekly_all', percent: 37, resets_at: '2030-01-05T10:00:00+00:00' }] }))
process.env.TERMINAI_LOGIN_USAGE_FILE = LOGIN_USAGE
const cleanup = () => { for (const id of [A, B]) try { execFileSync('/usr/bin/security', ['delete-generic-password', '-s', SVC, '-a', id], { stdio: 'ignore' }) } catch {} ; fs.rmSync(WORK, { recursive: true, force: true }) }

// ---- a fake Anthropic: who signed each request, and a plan that runs out on demand ----
const seen = [], reject = new Set()
const reset = Math.floor(Date.now() / 1000) + 3600
const upstream = http.createServer((req, res) => {
  const chunks = []
  req.on('data', c => chunks.push(c)).on('end', () => {
    const by = who(req.headers.authorization)
    seen.push({ path: req.url, by, beta: req.headers['anthropic-beta'], body: Buffer.concat(chunks).toString() })
    if (reject.has(by)) {
      res.writeHead(429, { 'content-type': 'application/json', 'anthropic-ratelimit-unified-status': 'rejected', 'anthropic-ratelimit-unified-reset': String(reset) })
      return res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: `limit for ${by}` } }))
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'anthropic-ratelimit-unified-status': 'allowed', 'anthropic-ratelimit-unified-5h-utilization': by === 'login' ? '0.2' : by === 'A' ? '0.6' : '0.85', 'anthropic-ratelimit-unified-7d-utilization': '0.3', 'anthropic-ratelimit-unified-5h-reset': String(reset), 'anthropic-ratelimit-unified-7d-reset': String(reset + 86400) })
    res.write(`event: message_start\ndata: {"by":"${by}"}\n\n`)
    setTimeout(() => { res.write('event: ping\ndata: {}\n\n') }, 400)
    setTimeout(() => { res.end('event: message_stop\ndata: {}\n\n') }, 900)
  })
})
const delay = ms => new Promise(r => setTimeout(r, ms))
let relay = ''
/** One request through the relay, as Claude Code would send it; resolves with status, body and when the first byte came. */
function call(key, urlPath, { method = 'POST', body = '{"model":"x","stream":true}', headers = { authorization: `Bearer ${LOGIN}` } } = {}) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now()
    const req = http.request(`${relay}/${key}${urlPath}`, { method, headers: { ...headers, 'anthropic-beta': 'oauth-2025-04-20', 'content-type': 'application/json' } }, res => {
      let text = '', first = 0
      res.on('data', c => { if (!first) first = Date.now() - t0; text += c })
      res.on('end', () => resolve({ status: res.statusCode, text, first, total: Date.now() - t0 }))
    })
    req.on('error', reject)
    req.end(method === 'POST' ? body : undefined)
  })
}
const tabOf = key => { try { return fs.readFileSync(path.join(dir, 'accounts', 'tabs', key), 'utf8') } catch { return '' } }
const setTab = (key, id) => fs.writeFileSync(path.join(dir, 'accounts', 'tabs', key), id)
const state = () => JSON.parse(fs.readFileSync(path.join(dir, 'accounts', 'accounts.json'), 'utf8'))
const LOG = path.join(WORK, 'fake.log')
const starts = () => { try { return fs.readFileSync(LOG, 'utf8').split('\n').filter(l => l.startsWith('start ')) } catch { return [] } }
async function waitFor(what, pred, ms) { const t = Date.now(); while (Date.now() - t < ms) { if (await pred()) return; await delay(200) } throw new Error(`timeout waiting for ${what}`) }
// Never execFileSync here: the control server answers from this very process, which would be blocked.
const cli = (...args) => new Promise((resolve, reject) => execFile(process.execPath, [path.join(REPO, 'resources/terminai.cjs'), ...args], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', TERMINAI_CONTROL: path.join(dir, 'control.json') } }, (e, out, err) => e ? reject(new Error(err || e.message)) : resolve(String(out))))

app.on('browser-window-created', (_e, win) => win.webContents.once('did-finish-load', () => { void (async () => {
  await waitFor('relay', () => fs.existsSync(path.join(dir, 'accounts', 'relay-url')), 10000)
  relay = fs.readFileSync(path.join(dir, 'accounts', 'relay-url'), 'utf8').trim()
  assert.match(relay, /^http:\/\/127\.0\.0\.1:\d+$/)

  // Numbers for the menu before any request: the login's from statusline.sh's cache, the others asked with the smallest request.
  await win.webContents.executeJavaScript(`window.term.accounts.refreshUsage()`)
  let list = await win.webContents.executeJavaScript(`window.term.accounts.list()`)
  assert.deepEqual(list.accounts.map(a => a.usage?.fiveHour), [0.19, 0.6, 0.85])
  assert.equal(list.accounts[0].usage.weekReset, Date.parse('2030-01-05T10:00:00+00:00'))
  assert.deepEqual(seen.map(s => s.by).sort(), ['A', 'B'], 'the login is never asked')
  assert.ok(seen.every(s => JSON.parse(s.body).max_tokens === 1 && /Claude Code/.test(JSON.parse(s.body).system)))
  seen.length = 0

  // A tab with no account of its own runs on the login, untouched, and the answer streams through.
  let r = await call('k1', '/v1/messages?beta=true')
  assert.equal(r.status, 200); assert.equal(seen.at(-1).by, 'login'); assert.equal(seen.at(-1).path, '/v1/messages?beta=true')
  assert.equal(seen.at(-1).beta, 'oauth-2025-04-20', 'anthropic-beta reaches Anthropic unchanged')
  assert.ok(r.first < 300 && r.total >= 850, `streamed, not buffered (first byte ${r.first} ms, end ${r.total} ms)`)
  // The tab's account signs model requests only; anything else keeps the login's own credentials.
  setTab('k1', A)
  await call('k1', '/v1/messages?beta=true'); assert.equal(seen.at(-1).by, 'A')
  await call('k1', '/api/hello', { method: 'HEAD' }); assert.equal(seen.at(-1).by, 'login'); assert.equal(seen.at(-1).path, '/api/hello')
  // A session launched with an API key of its own goes through untouched, whatever the tab's account.
  await call('k1', '/v1/messages?beta=true', { headers: { 'x-api-key': 'sk-ant-api03-fake' } }); assert.equal(seen.at(-1).by, 'other:undefined')
  // Automatic: the plan runs out mid-request and the same request goes out again on the next account.
  reject.add('A')
  const n = seen.length
  r = await call('k1', '/v1/messages?beta=true')
  assert.equal(r.status, 200, 'Claude Code never sees the limit')
  assert.deepEqual(seen.slice(n).map(s => s.by), ['A', 'B'])
  assert.equal(seen.at(-1).body, seen.at(-2).body, 'the retry is the same request')
  assert.equal(tabOf('k1'), B, 'the tab stays on the account that answered')
  assert.equal(state().exhausted[A], reset * 1000)
  // A tab still pointed at a spent account goes to the next one in menu order without asking Anthropic first.
  setTab('k2', A)
  const m = seen.length
  await call('k2', '/v1/messages?beta=true')
  assert.deepEqual(seen.slice(m).map(s => s.by), ['B']); assert.equal(tabOf('k2'), B)
  // Every account spent: the limit reaches Claude Code exactly as Anthropic gave it.
  reject.add('B'); reject.add('login')
  r = await call('k1', '/v1/messages?beta=true')
  assert.equal(r.status, 429); assert.match(r.text, /rate_limit_error/)
  // Manual: a limit is recorded, the tab stays where the user put it.
  await win.webContents.executeJavaScript(`window.term.accounts.setMode('manual')`)
  reject.clear(); reject.add('B'); setTab('k3', B)
  r = await call('k3', '/v1/messages?beta=true')
  assert.equal(r.status, 429); assert.equal(tabOf('k3'), B)
  list = await win.webContents.executeJavaScript(`window.term.accounts.list()`)
  assert.deepEqual(list.accounts.map(a => a.label).slice(1), ['Alpha', 'Beta'])
  assert.equal(list.accounts[0].usage.fiveHour, 0.2, 'usage read from the answer headers')
  assert.equal(list.accounts[0].usage.fiveReset, reset * 1000)
  assert.ok(list.accounts.every(a => a.exhaustedUntil === reset * 1000))
  assert.equal(state().usage[A].fiveHour, 0.6, 'usage is kept across restarts')

  // A real tab where claude's own folder comes first on the PATH, as ~/.zshrc does on this Mac: claude
  // still reaches the relay with the tab's key, and the menu moves the tab.
  fs.mkdirSync(path.join(WORK, 'fakebin'))
  execFileSync('clang', ['-O1', '-o', path.join(WORK, 'fakebin', 'claude'), path.join(__dirname, 'fixtures', 'fake-claude.c')])
  const line = `export PATH="${WORK}/fakebin:$PATH" FAKE_CLAUDE_LOG=${LOG}; claude`
  const { id } = JSON.parse(await cli('open', '--cwd', '/tmp', '--name', 'acct-e2e', '--command', line))
  await waitFor('fake claude', () => starts().length === 1, 15000)
  const key = /base=http:\/\/127\.0\.0\.1:\d+\/(\S+)/.exec(starts()[0])?.[1]
  assert.ok(key && starts()[0].includes(`base=${relay}/`), starts()[0])
  await cli('focus', id)
  await waitFor('account pill', () => win.webContents.executeJavaScript(`!!document.querySelector('.account-pill')`), 10000)
  await win.webContents.executeJavaScript(`document.querySelector('.account-pill').click()`)
  await waitFor('menu rows', async () => (await win.webContents.executeJavaScript(`document.querySelectorAll('.account-row').length`)) === 3, 3000)
  assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('.account-row .usage-bar').length`), 6, 'a 5-hour and a weekly bar per account')
  fs.writeFileSync(path.join(os.tmpdir(), 'terminai-accounts-menu.png'), (await win.capturePage()).toPNG())
  await win.webContents.executeJavaScript(`[...document.querySelectorAll('.account-pick')].find(b => b.textContent.includes('Alpha')).click()`)
  await waitFor('tab moved to Alpha', () => tabOf(key) === A, 3000)
  await waitFor('pill shows Alpha', async () => /Alpha/.test(await win.webContents.executeJavaScript(`document.querySelector('.account-pill')?.textContent || ''`)), 3000)
  assert.equal(starts().length, 1, 'picking an account restarts nothing')
  console.log('PASS accounts e2e: login untouched and streamed, tab account signs model requests only, automatic retry on the next account, spent accounts skipped, all spent → 429 as given, manual keeps the tab, usage from headers and probes, claude reaches the relay even when the PATH skips the shim, menu bars and a move without a restart')
  cleanup(); app.quit()
})().catch(e => { console.error(e); cleanup(); app.exit(1) }) }))
setTimeout(() => { console.error('e2e timeout'); cleanup(); app.exit(1) }, 120000).unref()
upstream.listen(0, '127.0.0.1', () => {
  process.env.TERMINAI_RELAY_UPSTREAM = `http://127.0.0.1:${upstream.address().port}`
  require(path.join(REPO, 'out/main/index.js'))
})
