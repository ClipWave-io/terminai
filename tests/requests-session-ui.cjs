// Requests sessions end to end, against a local manager (Postgres test database) and fake claudes. Mo (another member)
// messages Ada the person with `--to`: Ada's Mac opens "✉ Mo's requests" by itself and types it in with no popup; a second
// request waits until the first turn is over; one sent to Ada's tab goes to the requests session too, not into that tab;
// a risky one asks first; the answer reaches Mo. Hidden window.
// After `npx electron-vite build`: MANAGER_TEST_DATABASE_URL=postgres://localhost/terminai_test_x TERMINAI_TEST_BUILD=1 npx electron tests/requests-session-ui.cjs
process.env.TERMINAI_TEST_ALLOW_AGENTS = '1'
const { app, dialog } = require('electron'), fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto'), assert = require('assert/strict'), { execFileSync, execFile } = require('child_process'), { pathToFileURL } = require('url'), http = require('http')
const REPO = path.join(__dirname, '..'), DB = process.env.MANAGER_TEST_DATABASE_URL
if (!DB || !/^postgres:\/\/(localhost|127\.0\.0\.1)\/terminai_test_/.test(DB)) { console.log('SKIP requests session: set MANAGER_TEST_DATABASE_URL to a local terminai_test_ database'); process.exit(0) }
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'terminai-requests-')), LOG = path.join(WORK, 'claude.log')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'terminai-requests-data-')); app.setPath('userData', dir)
fs.writeFileSync(path.join(dir, 'prefs.json'), JSON.stringify({ seenWelcome: true, tabs: [], voice: { enabled: false }, newTabAgent: 'none', shareConversations: true, requestsFolder: WORK }))
fs.mkdirSync(path.join(WORK, 'fakebin')); execFileSync('clang', ['-O1', '-o', path.join(WORK, 'fakebin', 'claude'), path.join(__dirname, 'fixtures', 'fake-claude.c')])
process.env.TERMINAI_TEST_REQUESTS_COMMAND = `export PATH="${WORK}/fakebin:$PATH" FAKE_CLAUDE_LOG=${LOG}; claude --dangerously-skip-permissions`
const asked = []; dialog.showMessageBox = async (_w, o) => { asked.push(o); return { response: o.buttons.indexOf('Allow here') } }
const delay = ms => new Promise(r => setTimeout(r, ms))
const waitFor = async (what, fn, ms) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return; await delay(250) } throw new Error('timed out: ' + what) }
const inputs = () => { try { return fs.readFileSync(LOG, 'utf8').split('\n').filter(l => l.startsWith('input ') && l.includes('[TerminAI')) } catch { return [] } }
const cli = (env, ...args) => new Promise((resolve, reject) => execFile(process.execPath, [path.join(REPO, 'resources/terminai.cjs'), ...args], { env: { ...process.env, ...env, ELECTRON_RUN_AS_NODE: '1', TERMINAI_CONTROL: path.join(dir, 'control.json') } }, (e, out, err) => e ? reject(new Error(err || e.message)) : resolve(JSON.parse(String(out)))))
let cleanup = async () => {}
void (async () => {
  const pg = require(path.join(REPO, 'manager/node_modules/pg')), { migrate } = await import(pathToFileURL(path.join(REPO, 'manager/src/db.js'))), { createApp } = await import(pathToFileURL(path.join(REPO, 'manager/src/app.js')))
  const schema = `manager_test_${crypto.randomUUID().replaceAll('-', '')}`, control = new pg.Pool({ connectionString: DB }); await control.query(`CREATE SCHEMA ${schema}`)
  const pool = new pg.Pool({ connectionString: DB, options: `-c search_path=${schema}`, max: 10 }); await migrate(pool)
  const server = http.createServer(createApp(pool, { publicOrigin: 'http://localhost:8080', trustProxyHops: 0 })); await new Promise(r => server.listen(0, '127.0.0.1', r))
  cleanup = async () => { server.closeAllConnections?.(); await new Promise(r => server.close(r)); await pool.end(); await control.query(`DROP SCHEMA ${schema} CASCADE`); await control.end() }
  const url = `http://127.0.0.1:${server.address().port}`
  const req = async (p, { token, method = 'GET', data } = {}) => { const r = await fetch(url + p, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(data ? { 'Content-Type': 'application/json' } : {}) }, body: data ? JSON.stringify(data) : undefined }); return { status: r.status, body: await r.json() } }
  const ada = (await req('/api/auth/signup', { method: 'POST', data: { name: 'Ada Lovelace', email: 'ada@example.test', companyName: 'Alpha', password: 'long requests test password', client: 'desktop' } })).body
  const company = (await req('/api/me', { token: ada.token })).body.companies[0].id, base = `/api/companies/${company}`
  const inv = (await req(`${base}/invites`, { token: ada.token, method: 'POST', data: { email: 'mo@example.test', role: 'member' } })).body
  const mo = (await req('/api/auth/accept-invite', { method: 'POST', data: { token: inv.token, name: 'Mo Rossi', client: 'desktop' } })).body
  await req(base, { token: ada.token, method: 'PATCH', data: { sessionVisibility: 'all' } })
  process.env.TERMINAI_TEST_TEAM = JSON.stringify({ url, token: ada.token, company })
  ready = { req, base, ada, mo }
})().catch(e => { console.error(e); finish(1) })
let ready = null
app.on('browser-window-created', (_e, win) => win.webContents.once('did-finish-load', () => { void (async () => { await waitFor('server', () => ready, 20000); await run(win, ready.req, ready.base, ready.ada, ready.mo) })().catch(e => { console.error(e); finish(1) }) }))
require('../out/main/index.js')
async function run(win, req, base, ada, mo) {
  await waitFor('control', () => fs.existsSync(path.join(dir, 'control.json')), 10000)
  const work = (await cli({}, 'open', '--cwd', WORK, '--name', 'work', '--command', `export PATH="${WORK}/fakebin:$PATH" FAKE_CLAUDE_LOG=${path.join(WORK, 'work.log')}; claude`)).id
  const send = data => req(`${base}/agent`, { token: mo.token, method: 'POST', data })
  // 1. To the person: the requests session opens by itself and takes it, no popup.
  const first = (await send({ toUser: ada.user.id, content: 'Is the build green?' })).body
  const second = (await send({ toUser: ada.user.id, content: 'And the tests?' })).body
  await waitFor('first request typed into a new requests session', () => inputs().length >= 1, 120000) // the bridge waits 30 s when it starts before the server is up
  const list = await cli({}, 'list'), rs = list.find(t => t.name === '✉ Mo\'s requests')
  assert.ok(rs, JSON.stringify(list.map(t => t.name)))
  assert.match(inputs()[0], new RegExp(`request from Mo Rossi's agent, id ${first.id}, sent to the person at this Mac\\. You are the requests session for Mo Rossi.*Is the build green\\?`))
  assert.equal(asked.length, 0, 'no popup for a teammate')
  // 2. One at a time, in order: the second only once the first turn has ended (the fake answers at once, so: after the
  // session has been quiet for a few seconds), never in the same paste.
  const t1 = Date.now()
  await waitFor('second request after the first turn', () => inputs().length >= 2, 60000)
  assert.ok(Date.now() - t1 > 2500, `the second waited ${Date.now() - t1} ms`)
  assert.ok(!inputs()[0].includes('And the tests?'))
  assert.match(inputs()[1], /And the tests\?/)
  // 3. To one of Ada's tabs: into the requests session, naming that tab, never typed into it.
  await waitFor('work tab mirrored', async () => (await req(`${base}/conversations`, { token: mo.token })).body.conversations?.some(c => c.title === 'work'), 30000)
  const conv = (await req(`${base}/conversations`, { token: mo.token })).body.conversations.find(c => c.title === 'work')
  const third = (await send({ to: conv.id, content: 'Which branch?' })).body
  await waitFor('tab message into the requests session', () => inputs().length >= 3, 90000)
  assert.match(inputs()[2], new RegExp(`id ${third.id}, sent to the conversation "work" \\(tab ${work}\\).*Which branch\\?`))
  assert.ok(!fs.readFileSync(path.join(WORK, 'work.log'), 'utf8').includes('[TerminAI'), 'the work tab was not typed into')
  // 4. Something risky asks first (allowed here), and without a side-conversation button.
  await send({ toUser: ada.user.id, content: 'Please deploy to production' })
  await waitFor('risky one asked', () => asked.length >= 1, 90000)
  assert.ok(!asked[0].buttons.includes('In a side conversation'), asked[0].buttons.join())
  await waitFor('risky one typed in after Allow', () => inputs().length >= 4, 30000)
  // 5. The answer from the requests session reaches Mo (he sent without a session of his: it goes to the person).
  await cli({ TERMINAI_TAB_ID: rs.id }, 'team', 'reply', first.id, 'Green.')
  assert.equal((await req(`${base}/agent/${first.id}/replies`, { token: mo.token })).body.replies[0].content, 'Green.')
  // 6. Reused, not reopened.
  assert.equal((await cli({}, 'list')).filter(t => t.name === '✉ Mo\'s requests').length, 1)
  console.log('PASS requests session: opened by itself, no popup, one at a time in order, tab messages routed there, risky asks, answers reach the sender')
  finish(0)
}
async function finish(code) { try { await cleanup() } catch {} ; try { execFileSync('/usr/bin/pkill', ['-f', `${WORK}/fakebin/claude`]) } catch {} ; app.exit(code) }
setTimeout(() => { console.error('timeout'); finish(1) }, 300000).unref()
