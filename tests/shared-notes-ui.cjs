// The account gate, then shared notes in the To-do (Tasks | Notes): signed in with Sync, a note is written, a file dropped in and opened,
// and what the teammate adds on the server shows up. Runs against a local manager over HTTPS with a throwaway cert.
// After `npx electron-vite build`: CODEX_HOME=<scratch dir> MANAGER_TEST_DATABASE_URL=postgres://…/terminai_test_x TERMINAI_TEST_BUILD=1 npx electron tests/shared-notes-ui.cjs
const { app } = require('electron'), fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert/strict'), https = require('https'), { execFileSync } = require('child_process'), { randomUUID } = require('crypto')
if (!process.env.CODEX_HOME || !process.env.MANAGER_TEST_DATABASE_URL) { console.error('Set CODEX_HOME and MANAGER_TEST_DATABASE_URL.'); process.exit(1) }
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0' // the throwaway local certificate only
process.env.TERMINAI_TEST_ACCOUNT_GATE = '1'   // test builds skip the gate unless asked
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'terminai-shared-notes-')); app.setPath('userData', dir)
fs.writeFileSync(path.join(dir, 'prefs.json'), JSON.stringify({ seenWelcome: true, tabs: [], voice: { enabled: false }, tasksUser: 'ilai' }))
const delay = ms => new Promise(r => setTimeout(r, ms)), out = process.env.SHOTS || os.tmpdir()
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem'), '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' })
const attachment = path.join(dir, 'Launch checklist.txt'); fs.writeFileSync(attachment, 'one\ntwo\n')
let pool, control, schema, server
app.on('browser-window-created', (_e, win) => win.webContents.once('did-finish-load', () => { void (async () => {
  const js = code => win.webContents.executeJavaScript(code)
  const waitFor = async (what, code, ms = 8000) => { for (const t = Date.now(); Date.now() - t < ms; await delay(150)) if (await js(code)) return; throw new Error(`timeout: ${what} · ${await js(`JSON.stringify({ sheet: !!document.querySelector('.todo-sheet'), notes: document.querySelector('.todo-note')?.innerText.slice(0, 300) })`)}`) }
  const type = (selector, value) => js(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); const set = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set; set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', { bubbles: true })) })()`)
  const pg = require(path.join(__dirname, '../manager/node_modules/pg')), { migrate } = await import('../manager/src/db.js'), { createApp } = await import('../manager/src/app.js')
  schema = `manager_test_${randomUUID().replaceAll('-', '')}`
  control = new pg.Pool({ connectionString: process.env.MANAGER_TEST_DATABASE_URL }); await control.query(`CREATE SCHEMA ${schema}`)
  pool = new pg.Pool({ connectionString: process.env.MANAGER_TEST_DATABASE_URL, options: `-c search_path=${schema}` }); await migrate(pool)
  server = https.createServer({ key: fs.readFileSync(path.join(dir, 'k.pem')), cert: fs.readFileSync(path.join(dir, 'c.pem')) }, (q, r) => handler(q, r))
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const url = `https://localhost:${server.address().port}`, handler = createApp(pool, { publicOrigin: url, trustProxyHops: 0 })
  await delay(1000); win.setSize(1400, 860)

  // No account on this Mac: the gate covers the window and offers sign in and sign up; once signed in it goes away for good.
  await waitFor('account gate', `!!document.querySelector('.account-gate .team-auth h2')`)
  assert.equal(await js(`document.querySelector('.account-gate h2').textContent`), 'Sign in to sync')
  assert.equal(await js(`!!document.querySelector('.account-gate [aria-label="Close"]')`), false, 'the gate cannot be closed')
  // Sign in with browser: the app shows a code; whoever is signed in on the website allows it; the gate goes.
  const web = await (await fetch(`${url}/api/auth/signup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Web Person', email: 'web@example.test', password: 'long browser login password', client: 'desktop' }) })).json()
  await js(`(() => { const server = document.querySelector('.account-gate input[type=url]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(server, ${JSON.stringify(url)}); server.dispatchEvent(new Event('input', { bubbles: true })) })()`)
  await js(`document.querySelector('.account-gate .team-browser').click()`)
  await waitFor('code shown', `/^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(document.querySelector('.team-browser-wait strong')?.textContent || '')`)
  const code = await js(`document.querySelector('.team-browser-wait strong').textContent`)
  fs.writeFileSync(path.join(out, 'terminai-account-gate.png'), (await win.webContents.capturePage()).toPNG())
  const allowed = await fetch(`${url}/api/auth/device/approve`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${web.token}` }, body: JSON.stringify({ code }) })
  assert.equal(allowed.status, 200)
  await waitFor('gate gone', `!document.querySelector('.account-gate')`, 10000)
  assert.equal((await js(`window.term.workspace.state()`)).identity.user.email, 'web@example.test')
  await js(`window.term.workspace.logout()`)

  // Signed out again (the gate shows only at launch): the Notes view says what it is and offers Sync.
  await js(`document.querySelector('[aria-label^="To-do"]').click()`); await delay(700)
  await js(`[...document.querySelectorAll('.todo-seg button')].find(b => b.textContent === 'Notes').click()`)
  await waitFor('sign-in prompt', `document.querySelector('.snotes-empty button')?.textContent === 'Sign in to Sync'`)
  await js(`document.querySelector('.todo-sheet').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))`); await delay(300)
  assert.equal(await js(`!!document.querySelector('.todo-sheet')`), false)

  const me = await js(`window.term.workspace.login(${JSON.stringify({ url, signup: true, name: 'Ilai B', email: 'ilai@example.test', password: 'long shared notes password' })})`)
  const company = me.identity.companies[0].id, notes = `/api/companies/${company}/notes`
  await js(`document.querySelector('[aria-label^="To-do"]').click()`); await delay(700)
  await waitFor('Notes view kept', `!!document.querySelector('.snotes-list')`)
  assert.equal(await js(`document.querySelector('.snotes-none').textContent`), 'No shared notes yet')

  // A new note, a title and text typed in; it saves by itself.
  await js(`document.querySelector('[aria-label="New note"]').click()`)
  await waitFor('new note', `document.querySelector('.snotes-title')?.value === 'New note'`)
  await type('.snotes-title', 'Launch plan'); await type('.snotes-body', 'Domain first\nThen the landing page')
  await delay(1200)
  const saved = (await pool.query(`SELECT title,body,kind,visibility FROM manager_notes`)).rows
  assert.deepEqual(saved, [{ title: 'Launch plan', body: 'Domain first\nThen the landing page', kind: 'doc', visibility: 'company' }])
  assert.equal(await js(`document.querySelector('.snotes-item.on strong').textContent`), 'Launch plan')

  // A file added to it (as a drop would), listed with its size, and opened in the Files pane.
  const id = (await pool.query(`SELECT id FROM manager_notes`)).rows[0].id
  await js(`window.term.workspace.attach(${JSON.stringify(`${notes}/${id}`)}, ${JSON.stringify(attachment)})`)
  await js(`document.querySelector('[aria-label="New note"]').click()`); await delay(600)
  await js(`[...document.querySelectorAll('.snotes-item')].find(b => b.querySelector('strong').textContent === 'Launch plan').click()`)
  await waitFor('file chip', `document.querySelector('.snotes-file span')?.textContent === 'Launch checklist.txt'`)
  assert.equal(await js(`document.querySelector('.snotes-file small').textContent`), '8 B')
  fs.writeFileSync(path.join(out, 'terminai-shared-notes.png'), (await win.webContents.capturePage()).toPNG())
  await js(`document.querySelector('.snotes-file').click()`); await delay(1500)
  const cached = fs.readdirSync(path.join(dir, 'note-files')).map(f => fs.readFileSync(path.join(dir, 'note-files', f, 'Launch checklist.txt'), 'utf8'))
  assert.deepEqual(cached, ['one\ntwo\n'])

  // Delete asks first, then removes it for everyone.
  await js(`[...document.querySelectorAll('.snotes-head .todo-link')].find(b => b.textContent === 'Delete').click()`); await delay(200)
  assert.equal(await js(`document.querySelector('.snotes-ask').textContent`), 'Delete for everyone?')
  await js(`document.querySelector('.snotes-head .todo-link.danger').click()`); await delay(800)
  assert.deepEqual((await pool.query(`SELECT title FROM manager_notes ORDER BY title`)).rows.map(r => r.title), ['New note'])
  assert.equal((await pool.query(`SELECT count(*)::int n FROM manager_note_files`)).rows[0].n, 0)

  // Back to Tasks: the columns are where they were.
  await js(`[...document.querySelectorAll('.todo-seg button')].find(b => b.textContent === 'Tasks').click()`); await delay(400)
  assert.equal(await js(`!!document.querySelector('.todo-cols')`), true)
  console.log('PASS shared notes: sign-in prompt, write and autosave, attach, open from the Files pane, delete for everyone, back to tasks')
  await finish(0)
})().catch(async e => { console.error(e); await finish(1) }) }))
async function finish(code) {
  try { server?.close(); await pool?.end(); await control?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await control?.end() } catch {}
  fs.rmSync(dir, { recursive: true, force: true }); app.exit(code)
}
setTimeout(() => { console.error('shared notes UI timeout'); app.exit(1) }, 50000).unref()
require(path.join(__dirname, '../out/main/index.js'))
