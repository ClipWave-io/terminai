// A workspace member signs in on a Mac without the shared page: it turns on by itself, through the server only. Their own
// column comes first, then Ilai, Together, Matteo and one per other member; the columns scroll sideways; a column hides
// and comes back; a task typed in their column reaches the server signed with their key; terminai todo add --to <first name>.
// Runs against a local manager over HTTPS with a throwaway cert.
// After `npx electron-vite build`: CODEX_HOME=<scratch dir> MANAGER_TEST_DATABASE_URL=postgres://…/terminai_test_x TERMINAI_TEST_BUILD=1 npx electron tests/todo-members-ui.cjs
const { app } = require('electron'), fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert/strict'), https = require('https'), { execFile, execFileSync } = require('child_process'), { randomUUID } = require('crypto')
if (!process.env.CODEX_HOME || !process.env.MANAGER_TEST_DATABASE_URL) { console.error('Set CODEX_HOME and MANAGER_TEST_DATABASE_URL.'); process.exit(1) }
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0' // the throwaway local certificate only
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'terminai-todo-members-')); app.setPath('userData', dir)
// A member's Mac: the shared page off, the default local key (as every new Mac has it).
fs.writeFileSync(path.join(dir, 'prefs.json'), JSON.stringify({ seenWelcome: true, tabs: [], voice: { enabled: false }, tasksUser: 'ilai', teamTasks: false }))
const delay = ms => new Promise(r => setTimeout(r, ms)), out = process.env.SHOTS || os.tmpdir()
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem'), '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' })
const session = (...args) => new Promise(resolve => execFile(process.execPath, [path.join(__dirname, '..', 'resources/terminai.cjs'), ...args], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', TERMINAI_CONTROL: path.join(dir, 'control.json'), TERMINAI_TODO_DIR: dir } }, (e, stdout, err) => resolve({ ok: !e, out: String(stdout), err: String(err) })))
let pool, control, schema, server
app.on('browser-window-created', (_e, win) => win.webContents.once('did-finish-load', () => { void (async () => {
  const js = code => win.webContents.executeJavaScript(code)
  const heads = `[...document.querySelectorAll('.todo-cols > .todo-col')].map(c => c.getAttribute('aria-label'))`
  const waitFor = async (what, code, ms = 10000) => { for (const t = Date.now(); Date.now() - t < ms; await delay(150)) if (await js(code)) return; throw new Error(`timeout: ${what} · ${await js(`JSON.stringify({ heads: ${heads}, error: document.querySelector('.todo-error')?.textContent, rows: [...document.querySelectorAll('.todo-row[data-id] .todo-text')].map(t => t.value) })`)}`) }
  const pg = require(path.join(__dirname, '../manager/node_modules/pg')), { migrate } = await import('../manager/src/db.js'), { createApp } = await import('../manager/src/app.js')
  schema = `manager_test_${randomUUID().replaceAll('-', '')}`
  control = new pg.Pool({ connectionString: process.env.MANAGER_TEST_DATABASE_URL }); await control.query(`CREATE SCHEMA ${schema}`)
  pool = new pg.Pool({ connectionString: process.env.MANAGER_TEST_DATABASE_URL, options: `-c search_path=${schema}` }); await migrate(pool)
  server = https.createServer({ key: fs.readFileSync(path.join(dir, 'k.pem')), cert: fs.readFileSync(path.join(dir, 'c.pem')) }, (q, r) => handler(q, r))
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const url = `https://localhost:${server.address().port}`, handler = createApp(pool, { publicOrigin: url, trustProxyHops: 0 })
  const api = async (p, token, method = 'GET', data) => { const r = await fetch(url + p, { method, headers: { Authorization: `Bearer ${token}`, ...(data ? { 'Content-Type': 'application/json' } : {}) }, body: data ? JSON.stringify(data) : undefined }); return { status: r.status, body: await r.json() } }
  const pw = 'long member columns password'
  // Ilai's workspace, his column, two members joined by links limited to ManyMotions.org, and a link for Sofia.
  const ilai = await (await fetch(`${url}/api/auth/signup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Ilai', email: 'ilai@example.test', companyName: 'BUILD', password: pw, client: 'desktop' }) })).json()
  const company = (await api('/api/me', ilai.token)).body.companies[0].id, base = `/api/companies/${company}`
  await api(`${base}/tasks/people`, ilai.token, 'PUT', { key: 'ilai' })
  const join = async (name, email) => {
    const link = (await api(`${base}/invites/link`, ilai.token, 'POST', { role: 'member', products: ['ManyMotions.org'] })).body.inviteUrl.split('#invite=')[1]
    return { link, join: () => fetch(`${url}/api/auth/accept-invite`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: link, name, email, password: pw, client: 'desktop' }) }).then(r => r.json()) }
  }
  for (const [name, email] of [['Fritz Meier', 'fritz@example.test'], ['Nora Keller', 'nora@example.test'], ['Paul Weber', 'paul@example.test']]) await (await join(name, email)).join()
  const sofiaInvite = (await join('Sofia Rossi', 'sofia@example.test')).link
  await delay(1000); win.setSize(1400, 860); await delay(300)

  // Sofia signs in on this Mac with her invite: within a moment the shared page is on, under her own key.
  const state = await js(`window.term.workspace.login(${JSON.stringify({ url, inviteToken: sofiaInvite, name: 'Sofia Rossi', email: 'sofia@example.test', password: pw })})`)
  const sofiaId = state.identity.user.id, sofia = `u:${sofiaId}`
  const members = (await api(`${base}/tasks`, ilai.token)).body.members, keyOf = name => members.find(m => m.name.startsWith(name)).key
  await api(`${base}/tasks/t-org`, ilai.token, 'PUT', { task: { id: 't-org', title: 'Org landing', notes: '', status: 'open', product: 'ManyMotions.org', assignee: sofia, createdAt: new Date().toISOString(), createdBy: 'ilai', updatedBy: 'ilai' } })
  await api(`${base}/tasks/t-cold`, ilai.token, 'PUT', { task: { id: 't-cold', title: 'ColdWave pricing', notes: '', status: 'open', product: 'ColdWave', assignee: 'both', createdAt: new Date().toISOString(), createdBy: 'ilai', updatedBy: 'ilai' } })
  await js(`window.term.todos.sync()`)
  for (let t = Date.now(); Date.now() - t < 8000 && JSON.parse(fs.readFileSync(path.join(dir, 'prefs.json'), 'utf8')).tasksKey !== sofia; await delay(200)) await js(`window.term.todos.sync()`)
  const prefs = JSON.parse(fs.readFileSync(path.join(dir, 'prefs.json'), 'utf8'))
  assert.equal(prefs.tasksKey, sofia); assert.equal(prefs.teamTasks, true)
  assert.equal(fs.existsSync(path.join(dir, 'build-tasks')), false, 'no clone of the repo')
  assert.equal((await api(`${base}/tasks`, ilai.token)).body.people.ilai.name, 'Ilai', 'she never took a column')
  assert.equal((await api(`${base}/tasks`, ilai.token)).body.people.livio, undefined)

  // Her column first, then Ilai, Together, Matteo, then the others by first name; only her product's tasks.
  await js(`document.querySelector('[aria-label^="To-do"]').click()`); await delay(800)
  await waitFor('member columns', `JSON.stringify(${heads}) === '["Sofia","Ilai","Together","Matteo","Fritz","Nora","Paul"]'`)
  await waitFor('her task', `[...document.querySelectorAll('.todo-col[aria-label="Sofia"] .todo-text')].some(t => t.value === 'Org landing')`)
  assert.equal(await js(`[...document.querySelectorAll('.todo-text')].some(t => t.value === 'ColdWave pricing')`), false, 'another product stays out')
  assert.equal(await js(`document.querySelector('.todo-you')?.textContent`), 'Sofia')
  // Seven columns of at least 300 px: the row scrolls sideways to the last one.
  const scroll = await js(`(() => { const c = document.querySelector('.todo-cols'); return { sw: c.scrollWidth, cw: c.clientWidth, ox: getComputedStyle(c).overflowX } })()`)
  assert.ok(scroll.sw > scroll.cw + 300, JSON.stringify(scroll)); assert.equal(scroll.ox, 'auto')
  await js(`(() => { const c = document.querySelector('.todo-cols'); c.scrollLeft = c.scrollWidth })()`); await delay(400)
  const last = await js(`(() => { const c = document.querySelector('.todo-cols').getBoundingClientRect(), p = document.querySelector('.todo-col[aria-label="Paul"]').getBoundingClientRect(); return p.right <= c.right + 1 && p.left >= c.left - 1 })()`)
  assert.ok(last, 'the last column scrolled into view')
  fs.writeFileSync(path.join(out, 'terminai-todo-members.png'), (await win.webContents.capturePage()).toPNG())
  await js(`(() => { const c = document.querySelector('.todo-cols'); c.scrollLeft = 0 })()`)

  // Hidden on this Mac, then all shown again.
  await js(`document.querySelector('.todo-col[aria-label="Nora"] .todo-col-hide').click()`)
  await waitFor('Nora hidden', `!${heads}.includes('Nora') && /1 hidden/.test(document.querySelector('.todo-hidden-cols')?.textContent || '')`)
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'prefs.json'), 'utf8')).todoHiddenColumns, [keyOf('Nora')])
  await js(`document.querySelector('.todo-hidden-cols').click()`)
  await waitFor('all shown', `${heads}.includes('Nora')`)

  // Typed in her column: on the server at once, in her product, signed with her key.
  await js(`document.querySelector('.todo-col[aria-label="Sofia"] .todo-row.draft .todo-text').focus()`)
  await win.webContents.insertText('Write the FAQ')
  await js(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))`)
  let faq
  for (let t = Date.now(); Date.now() - t < 8000 && !faq; await delay(200)) faq = (await api(`${base}/tasks`, ilai.token)).body.tasks.find(x => x.title === 'Write the FAQ')
  assert.ok(faq, 'reached the server'); assert.equal(faq.assignee, sofia); assert.equal(faq.updatedBy, sofia); assert.equal(faq.product, 'ManyMotions.org')
  // A change on the server (Ilai moves it to Fritz) shows after a sync.
  await api(`${base}/tasks/${faq.id}`, ilai.token, 'PUT', { task: { ...faq, assignee: keyOf('Fritz'), updatedAt: new Date().toISOString(), updatedBy: 'ilai' } })
  await js(`window.term.todos.sync()`)
  await waitFor('moved to Fritz', `[...document.querySelectorAll('.todo-col[aria-label="Fritz"] .todo-text')].some(t => t.value === 'Write the FAQ')`)

  // A session adds to another member's column by first name; the map lists the member columns, hers first.
  const r = await session('todo', 'add', 'Translate the pricing page', '--to', 'nora')
  assert.ok(r.ok, r.err); assert.equal(JSON.parse(r.out).page, 'Nora')
  assert.equal((await api(`${base}/tasks`, ilai.token)).body.tasks.find(x => x.title === 'Translate the pricing page').assignee, keyOf('Nora'))
  const map = await session('todo', 'map'); assert.ok(map.ok, map.err)
  assert.deepEqual(JSON.parse(map.out).shared.map(c => c.to), ['sofia', 'ilai', 'together', 'matteo', 'unassigned', 'fritz', 'nora', 'paul'])
  console.log(`PASS todo members: a member's Mac turns the shared page on at sign-in (server only, no column taken), own column first then Ilai, Together, Matteo and each member, product limits, sideways scroll to the 7th column, hide and show, a typed task signed with u:<id>, a server change synced in, todo add --to <first name>, todo map · screenshot ${path.join(out, 'terminai-todo-members.png')}`)
  await finish(0)
})().catch(async e => { console.error(e); await finish(1) }) }))
async function finish(code) {
  try { server?.close(); await pool?.end(); await control?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await control?.end() } catch {}
  fs.rmSync(dir, { recursive: true, force: true }); app.exit(code)
}
setTimeout(() => { console.error('todo members UI timeout'); app.exit(1) }, 90000).unref()
require(path.join(__dirname, '../out/main/index.js'))
