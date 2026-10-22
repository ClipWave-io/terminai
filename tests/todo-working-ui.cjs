// `terminai todo start|done|reopen` from a tab: the task goes in progress for both Macs, its row links to the tab on
// this Mac only, a click on the link goes to the tab; the other one's task is refused.
// After `npx electron-vite build`: CODEX_HOME=<scratch dir> TERMINAI_TEST_BUILD=1 npx electron tests/todo-working-ui.cjs
const { app } = require('electron'), fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert/strict'), { execFile, execFileSync } = require('child_process')
if (!process.env.CODEX_HOME) { console.error('Set CODEX_HOME to a scratch folder: the app writes its Codex config there.'); process.exit(1) }
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'terminai-todo-working-')), bare = path.join(root, 'tasks.git'), ilai = path.join(root, 'ilai')
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
git(root, 'init', '-q', '--bare', '-b', 'main', bare); git(root, 'clone', '-q', bare, ilai)
fs.mkdirSync(path.join(ilai, 'tasks')); fs.writeFileSync(path.join(ilai, 'tasks/.gitkeep'), ''); git(ilai, 'add', '-A'); git(ilai, 'commit', '-q', '-m', 'seed'); git(ilai, 'push', '-q', 'origin', 'HEAD:main')
const dir = path.join(root, 'userData'); fs.mkdirSync(dir); app.setPath('userData', dir)
fs.writeFileSync(path.join(dir, 'prefs.json'), JSON.stringify({ seenWelcome: true, tabs: [], voice: { enabled: false }, tasksUser: 'livio' }))
process.env.TERMINAI_TASKS_REMOTE = `file://${bare}`
const delay = ms => new Promise(r => setTimeout(r, ms))
// Never execFileSync here: the control server answers from this very process. `tab`: the TERMINAI_TAB_ID of the tab it runs in.
const cli = (tab, ...args) => new Promise(resolve => execFile(process.execPath, [path.join(__dirname, '..', 'resources/terminai.cjs'), ...args],
  { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', TERMINAI_CONTROL: path.join(dir, 'control.json'), TERMINAI_TAB_ID: tab ?? '', TERMINAI_TODO_DIR: dir, TERMINAI_TASKS_DIR: path.join(dir, 'build-tasks', 'tasks') } },
  (e, out, err) => resolve({ ok: !e, out: String(out), err: String(err), json: (() => { try { return JSON.parse(out) } catch { return null } })() })))
app.on('browser-window-created', (_e, win) => win.webContents.once('did-finish-load', () => { void (async () => {
  const js = code => win.webContents.executeJavaScript(code)
  const waitFor = async (what, code, ms = 8000) => { for (const t = Date.now(); Date.now() - t < ms; await delay(150)) if (await js(code)) return; throw new Error(`timeout: ${what}`) }
  await delay(1500); win.setSize(1400, 860); await delay(300)
  await js(`window.term.todos.saveMany('shared', [{ title: 'Fix login page', assignee: 'both' }, { title: 'Call the bank', assignee: 'ilai' }])`)
  // A session in a tab of its own, in the background: the tab in view stays where it was.
  let r = await cli(null, 'open', '--cwd', root, '--name', 'Login work'); assert.ok(r.ok, r.err)
  const tab = r.json.id
  r = await cli(null, 'list'); const before = r.json.find(t => t.active)?.id
  assert.ok(before && before !== tab, 'another tab is in view')
  r = await cli(tab, 'todo', 'start', 'fix login'); assert.ok(r.ok, r.err)
  assert.deepEqual([r.json.title, r.json.status, r.json.tab?.name], ['Fix login page', 'doing', 'Login work'])
  const id = r.json.id
  assert.equal(git(bare, 'log', '-1', '--format=%s', 'main').trim(), 'livio: start Fix login page')
  // Ilai's Mac: in progress, nothing about the tab.
  git(ilai, 'pull', '-q', '--rebase')
  const theirs = fs.readFileSync(path.join(ilai, 'tasks', `${id}.json`), 'utf8')
  assert.equal(JSON.parse(theirs).status, 'doing'); assert.equal(theirs.includes('Login work'), false)
  r = await cli(tab, 'todo', 'start', 'call the bank'); assert.equal(r.ok, false); assert.match(r.err, /Ilai’s task/)
  // The row: "in progress" and the tab, which a click goes to.
  await js(`document.querySelector('[aria-label^="To-do"]').click()`)
  await waitFor('session tag', `(document.querySelector('.todo-row[data-id="${id}"] .todo-session')?.textContent || '') === 'Login work'`)
  assert.equal(await js(`!!document.querySelector('.todo-row[data-id="${id}"] .todo-tag.doing')`), true)
  assert.equal(await js(`document.querySelector('.todo-row[data-id="${id}"] .todo-session').disabled`), false)
  await delay(300)
  const shot = path.join(os.tmpdir(), 'terminai-todo-working.png')
  fs.writeFileSync(shot, (await win.webContents.capturePage(undefined, { stayHidden: true })).toPNG())
  await js(`document.querySelector('.todo-row[data-id="${id}"] .todo-session').click()`)
  await waitFor('sheet closed', `!document.querySelector('.todo-sheet')`)
  await delay(400)
  r = await cli(null, 'list'); assert.equal(r.json.find(t => t.active)?.id, tab, 'the tab working on it is in view')
  // terminai todo tells the other sessions which tab has it.
  r = await cli(null, 'todo', '--shared'); assert.equal(r.json.shared.find(t => t.id === id).session, 'Login work')
  // Done: the row loses the link and goes to the finished ones.
  await js(`document.querySelector('[aria-label^="To-do"]').click()`)
  await waitFor('sheet open', `!!document.querySelector('.todo-row[data-id="${id}"]')`)
  r = await cli(tab, 'todo', 'done', id); assert.ok(r.ok, r.err); assert.equal(r.json.status, 'done')
  await waitFor('done row', `!!document.querySelector('.todo-done .todo-row[data-id="${id}"]') && !document.querySelector('.todo-row[data-id="${id}"] .todo-session')`)
  assert.equal(git(bare, 'log', '-1', '--format=%s', 'main').trim(), 'livio: done Fix login page')
  // A tab closed since: the link stays as a name, not a button that goes nowhere.
  r = await cli(tab, 'todo', 'reopen', id); assert.ok(r.ok, r.err)
  r = await cli(tab, 'todo', 'start', id); assert.ok(r.ok, r.err)
  r = await cli(null, 'close', tab); assert.ok(r.ok, r.err)
  await waitFor('closed tab', `(() => { const b = document.querySelector('.todo-row[data-id="${id}"] .todo-session'); return !!b && b.disabled && b.textContent === 'Login work' })()`)
  console.log(`PASS todo working: start from a tab (commit "livio: start Fix login page", Ilai sees doing and no tab), the other one's task refused, the row links to the tab and a click goes there, session in terminai todo, done drops the link, a closed tab stays as a name · screenshot ${shot}`)
  fs.rmSync(root, { recursive: true, force: true }); app.quit()
})().catch(e => { console.error(e); fs.rmSync(root, { recursive: true, force: true }); app.exit(1) }) }))
setTimeout(() => { console.error('todo working timeout'); app.exit(1) }, 100000).unref()
require(path.join(__dirname, '../out/main/index.js'))
