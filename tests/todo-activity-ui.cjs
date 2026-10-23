// The To-do's Activity panel and bell, @tags, AI-signed edits, hidden columns, the product filter and the toolbar menu over the sheet.
// After `npx electron-vite build`: CODEX_HOME=<scratch dir> TERMINAI_TEST_BUILD=1 npx electron tests/todo-activity-ui.cjs
const electron = require('electron'), { app } = electron, fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert/strict'), { execFileSync } = require('child_process')
if (!process.env.CODEX_HOME) { console.error('Set CODEX_HOME to a scratch folder: the app writes its Codex config there.'); process.exit(1) }
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'terminai-todo-activity-')), bare = path.join(root, 'tasks.git'), matteo = path.join(root, 'matteo')
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
git(root, 'init', '-q', '--bare', '-b', 'main', bare); git(root, 'clone', '-q', bare, matteo)
fs.mkdirSync(path.join(matteo, 'tasks')); fs.writeFileSync(path.join(matteo, 'tasks/.gitkeep'), ''); git(matteo, 'add', '-A'); git(matteo, 'commit', '-q', '-m', 'seed'); git(matteo, 'push', '-q', 'origin', 'HEAD:main')
const dir = path.join(root, 'userData'); fs.mkdirSync(dir); app.setPath('userData', dir)
fs.writeFileSync(path.join(dir, 'prefs.json'), JSON.stringify({ seenWelcome: true, tabs: [], voice: { enabled: false }, tasksUser: 'ilai' }))
process.env.TERMINAI_TASKS_REMOTE = `file://${bare}`
const shown = []; electron.Notification.prototype.show = function () { shown.push(this.body) }
const prefs = () => JSON.parse(fs.readFileSync(path.join(dir, 'prefs.json'), 'utf8'))
const delay = ms => new Promise(r => setTimeout(r, ms))
const until = async (test, what, ms = 4000) => { for (let t = 0; t < ms; t += 100) { if (await test()) return; await delay(100) } assert.fail(`timed out: ${what}`) }
const out = name => path.join(os.tmpdir(), `terminai-todo-${name}.png`)
app.on('browser-window-created', (_e, win) => win.webContents.once('did-finish-load', () => { void (async () => {
  const js = code => win.webContents.executeJavaScript(code)
  const shot = async name => fs.writeFileSync(out(name), (await win.webContents.capturePage(undefined, { stayHidden: true })).toPNG())
  const titles = () => js(`[...document.querySelectorAll('.todo-col .todo-part .todo-row[data-id] .todo-text')].map(t => t.value)`)
  await delay(1200); win.setSize(1500, 900); await delay(300)
  let list = await js(`window.term.todos.save('shared', { title: 'Fix login', assignee: 'ilai', product: 'ManyMotions' })`)
  list = await js(`window.term.todos.save('shared', { title: 'Ship landing page', assignee: 'both', product: 'Abracadabrax' })`)
  list = await js(`window.term.todos.save('shared', { title: 'Call the university', assignee: 'livio' })`)
  const fix = list.shared.find(t => t.title === 'Fix login')

  // Matteo's Mac: his agent adds a line to the note that tags Ilai.
  git(matteo, 'pull', '-q', '--rebase')
  const later = new Date(Date.now() + 60_000).toISOString()
  fs.writeFileSync(path.join(matteo, 'tasks', `${fix.id}.json`), JSON.stringify({ ...fix, notes: 'Repro on staging\n@Ilai can you check the token?', updatedAt: later, updatedBy: 'livio', updatedVia: 'ai' }, null, 2) + '\n')
  git(matteo, 'add', '-A'); git(matteo, 'commit', '-q', '-m', 'livio: edit Fix login', '-m', 'Via: AI session'); git(matteo, 'push', '-q', 'origin', 'HEAD')
  await js(`window.term.todos.sync()`)
  assert.deepEqual(shown, ['Matteo’s AI tagged you in “Fix login”'])
  await until(() => js(`!!document.querySelector('.todo-notice.mention')`), 'the in-window notice')
  assert.match(await js(`document.querySelector('.todo-notice').textContent`), /^TaggedMatteo’s AI tagged you in “Fix login”$/)
  await until(() => js(`document.querySelector('.todo-bell-count')?.textContent === '1'`), 'the bell counts Matteo’s change')

  // The notice opens the sheet with the Activity panel: everyone's changes, his AI marked, the tag highlighted.
  await js(`document.querySelector('.todo-notice').click()`)
  await until(() => js(`document.querySelectorAll('.todo-activity-list li').length === 4`), 'four changes in Activity')
  const rows = await js(`[...document.querySelectorAll('.todo-activity-list li')].map(li => li.className + '|' + li.querySelector('.todo-activity-who').textContent + '|' + li.querySelector('.todo-activity-msg').textContent)`)
  assert.deepEqual(rows, ['fresh tagged|MatteoAI|edit Fix login', '|Ilai|add Call the university', '|Ilai|add Ship landing page', '|Ilai|add Fix login'])
  await until(() => js(`!document.querySelector('.todo-bell-count')`), 'the bell clears once shown')
  assert.ok(prefs().todoActivitySeen, 'seen saved')
  assert.equal(await js(`document.querySelector('.todo-mention.me')?.textContent`), '@Ilai')
  assert.match(await js(`document.querySelector('.todo-row.fresh .todo-fresh').textContent`), /^edited by Matteo’s AI · /)
  await js(`[...document.querySelectorAll('.todo-activity-filters button')].find(b => b.textContent === 'Matteo').click()`); await delay(100)
  assert.equal(await js(`document.querySelectorAll('.todo-activity-list li').length`), 1)
  await js(`[...document.querySelectorAll('.todo-activity-filters button')].find(b => b.textContent === 'Ilai').click()`); await delay(100)
  assert.equal(await js(`document.querySelectorAll('.todo-activity-list li').length`), 3)
  await js(`[...document.querySelectorAll('.todo-activity-filters button')].find(b => b.textContent === 'All').click()`); await delay(100)
  await shot('activity')
  await js(`document.querySelector('.todo-activity-list li button').click()`)
  await until(() => js(`/Matteo’s AI/.test(document.querySelector('.todo-history-list')?.textContent || '')`), 'history names his AI')
  await js(`[...document.querySelectorAll('.todo-history .btn')].find(b => b.textContent === 'Done').click()`); await delay(300)

  // Only my own column for now: hide Matteo's and Together, then show them all again.
  assert.equal(await js(`document.querySelectorAll('.todo-col').length`), 3)
  await js(`document.querySelector('[aria-label="Hide Matteo"]').click()`); await delay(200)
  await js(`document.querySelector('[aria-label="Hide Together"]').click()`); await delay(200)
  assert.deepEqual(await js(`[...document.querySelectorAll('.todo-col')].map(c => c.dataset.col)`), ['ilai'])
  assert.equal(await js(`!!document.querySelector('[aria-label="Hide Ilai"]')`), false, 'the last column cannot go')
  assert.deepEqual(prefs().todoHiddenColumns.sort(), ['both', 'livio'])
  assert.equal(await js(`document.querySelector('.todo-hidden-cols').textContent`), '2 hidden · Show all')
  await shot('own-column')
  // The Shared menu shows them one at a time, its check following while it stays open.
  await js(`document.querySelector('[aria-label="Showing shared tasks"]').click()`); await delay(150)
  await js(`[...document.querySelectorAll('.todo-menu button')].find(b => b.textContent === 'Together').click()`); await delay(150)
  assert.equal(await js(`[...document.querySelectorAll('.todo-menu button')].find(b => b.textContent === 'Together').getAttribute('aria-checked')`), 'true')
  assert.equal(await js(`document.querySelectorAll('.todo-col').length`), 2)
  await js(`document.querySelector('.todo-menu').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`); await delay(100)
  await js(`document.querySelector('.todo-hidden-cols').click()`); await delay(200)
  assert.equal(await js(`document.querySelectorAll('.todo-col').length`), 3)

  // Products: light blue tags; a click shows only that one, the menu adds more, saved on this Mac.
  const color = await js(`getComputedStyle(document.querySelector('.todo-product')).color`)
  assert.notEqual(color, await js(`getComputedStyle(document.querySelector('.todo-tag.doing, .todo-fresh') || document.body).color`))
  await js(`[...document.querySelectorAll('.todo-product')].find(b => b.textContent === 'ManyMotions').click()`); await delay(200)
  assert.deepEqual(await titles(), ['Fix login'])
  assert.deepEqual(prefs().todoProducts, ['ManyMotions'])
  await js(`document.querySelector('.todo-products').click()`); await delay(150)
  await js(`[...document.querySelectorAll('.todo-menu button')].find(b => b.textContent === 'Abracadabrax').click()`); await delay(150)
  assert.equal(await js(`[...document.querySelectorAll('.todo-menu button')].find(b => b.textContent === 'Abracadabrax').getAttribute('aria-checked')`), 'true', 'the menu stays open and ticks it')
  await js(`document.querySelector('.todo-menu').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`); await delay(100)
  assert.deepEqual((await titles()).sort(), ['Fix login', 'Ship landing page'])
  assert.equal(await js(`document.querySelector('.todo-products').textContent`), 'ManyMotions +1')
  await shot('products')
  await js(`document.querySelector('.todo-products').click()`); await delay(150)
  await js(`[...document.querySelectorAll('.todo-menu button')].find(b => b.textContent === 'All products').click()`); await delay(200)
  assert.equal((await titles()).length, 3)

  // An agent in a tab: `terminai todo start` is signed as AI in Activity.
  // Async: a synchronous call would block this very process, which has to answer it.
  await new Promise((resolve, reject) => require('child_process').execFile(process.env.NODE_BIN || 'node', [path.join(__dirname, '../resources/terminai.cjs'), 'todo', 'start', 'Ship landing page'], { env: { ...process.env, TERMINAI_CONTROL: path.join(dir, 'control.json') } }, (err, stdout, stderr) => err ? reject(new Error(stderr || err.message)) : resolve(stdout)))
  await until(() => js(`document.querySelector('.todo-activity-list li .todo-activity-msg')?.textContent === 'start Ship landing page'`), 'the agent’s change at the top')
  assert.equal(await js(`document.querySelector('.todo-activity-list li .todo-activity-who').textContent`), 'IlaiAI')

  // The toolbar's ⋯ menu opens over the sheet, not behind it.
  await js(`document.querySelector('[aria-label="Customize toolbar"]').click()`); await delay(200)
  assert.equal(await js(`(() => { const b = document.querySelector('.toolbar-customize').getBoundingClientRect(); return !!document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2)?.closest('.toolbar-customize') })()`), true)
  await shot('toolbar-over-todo')
  console.log(`PASS todo activity: tag notice "${shown[0]}" in window and bell, Activity with both people and AI, filters, history, own-column view, product filter saved, CLI edit signed AI, ⋯ over sheet · ${out('activity')} ${out('own-column')} ${out('products')}`)
  fs.rmSync(root, { recursive: true, force: true }); app.quit()
})().catch(e => { console.error(e); fs.rmSync(root, { recursive: true, force: true }); app.exit(1) }) }))
setTimeout(() => { console.error('todo activity UI timeout'); app.exit(1) }, 60000).unref()
require(path.join(__dirname, '../out/main/index.js'))
