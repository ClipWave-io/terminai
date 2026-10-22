// Private lists as pages: a new one named in place, tasks typed into it, the arrows (and ← →) between pages,
// Move to list, Delete list with Undo, and their names in terminai todo.
// After `npx electron-vite build`: CODEX_HOME=<scratch dir> TERMINAI_TEST_BUILD=1 npx electron tests/todo-lists-ui.cjs
const { app } = require('electron'), fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert/strict'), { execFileSync } = require('child_process')
if (!process.env.CODEX_HOME) { console.error('Set CODEX_HOME to a scratch folder: the app writes its Codex config there.'); process.exit(1) }
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'terminai-todo-lists-')); app.setPath('userData', dir)
fs.writeFileSync(path.join(dir, 'prefs.json'), JSON.stringify({ seenWelcome: true, tabs: [], voice: { enabled: false }, tasksUser: 'livio' }))
const delay = ms => new Promise(r => setTimeout(r, ms))
app.on('browser-window-created', (_e, win) => win.webContents.once('did-finish-load', () => { void (async () => {
  const js = code => win.webContents.executeJavaScript(code)
  const waitFor = async (what, code, ms = 8000) => { for (const t = Date.now(); Date.now() - t < ms; await delay(150)) if (await js(code)) return; throw new Error(`timeout: ${what} · ${await js(`JSON.stringify({ name: document.querySelector('.todo-page-name')?.textContent, input: document.querySelector('.todo-page-input')?.value, count: document.querySelector('.todo-page-count')?.textContent, active: document.activeElement?.className, error: document.querySelector('.todo-error')?.textContent, rows: [...document.querySelectorAll('.todo-col .todo-row .todo-text')].map(t => t.closest('.todo-row').className + ':' + t.value) })`)} · ${fs.existsSync(path.join(dir, 'todos-personal-livio.json')) ? fs.readFileSync(path.join(dir, 'todos-personal-livio.json'), 'utf8').replace(/\s+/g, ' ') : ''}`) }
  // The test window never takes the focus (showInactive), so keys go to the focused element as DOM events, as in editor-ui-smoke.
  const key = async (name) => { await js(`(document.activeElement || document.body).dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(name)}, bubbles: true, cancelable: true }))`); await delay(250) }
  const pageName = `document.querySelector('.todo-page-name')?.textContent || ''`
  const rows = `[...document.querySelectorAll('.todo-col .todo-part .todo-row[data-id] .todo-text')].map(t => t.value)`
  const click = async (selector) => { await js(`document.querySelector(${JSON.stringify(selector)}).click()`); await delay(250) }
  const menuItem = async (label) => { await js(`[...document.querySelectorAll('.todo-menu button')].find(b => b.textContent === ${JSON.stringify(label)}).click()`); await delay(300) }
  await delay(1200); win.setSize(1400, 860); await delay(300)
  await js(`window.term.todos.save('personal', { title: 'Buy milk' })`)
  await js(`document.querySelector('[aria-label^="To-do"]').click()`); await delay(800)
  // The view menu lists the private lists; there is one, without a page count.
  await click('.todo-drop')
  await menuItem('Private')
  await waitFor('private page', `${pageName} === 'PRIVATE'`)
  assert.deepEqual(await js(rows), ['Buy milk'])
  assert.equal(await js(`!!document.querySelector('.todo-page-count')`), false)
  // + makes a page and puts its name up to be typed over.
  await click('[aria-label="New list"]')
  await waitFor('name field', `document.activeElement?.classList.contains('todo-page-input') && document.activeElement.selectionEnd - document.activeElement.selectionStart === 'New list'.length`)
  await win.webContents.insertText('Unlocked Tour'); await key('Enter')
  await waitFor('named page', `${pageName} === 'UNLOCKED TOUR' && document.querySelector('.todo-page-count')?.textContent === '2 / 2'`)
  const lists = () => JSON.parse(fs.readFileSync(path.join(dir, 'todos-lists-livio.json'), 'utf8'))
  const tour = lists().find(l => l.name === 'Unlocked Tour'); assert.ok(tour)
  assert.deepEqual(await js(rows), [], 'a new page is empty')
  // Typed into the page, the tasks belong to it.
  await js(`document.querySelector('.todo-row.draft .todo-text').focus()`)
  await win.webContents.insertText('Call the guide'); await key('Enter')
  await win.webContents.insertText('Book the van'); await key('Enter')
  await waitFor('two tasks', `JSON.stringify(${rows}) === '["Call the guide","Book the van"]'`)
  const personal = () => JSON.parse(fs.readFileSync(path.join(dir, 'todos-personal-livio.json'), 'utf8'))
  assert.deepEqual(personal().filter(t => t.list === tour.id).map(t => t.title).sort(), ['Book the van', 'Call the guide'])
  await key('Escape')
  // The arrows turn the pages, and so do ← → once no field has the keys.
  await click('[aria-label="Previous list"]')
  await waitFor('back to Private', `${pageName} === 'PRIVATE' && document.querySelector('.todo-page-count')?.textContent === '1 / 2'`)
  assert.deepEqual(await js(rows), ['Buy milk'])
  assert.equal(await js(`document.querySelector('[aria-label="Previous list"]').disabled`), true)
  await js(`document.querySelector('.todo-sheet').focus()`); await key('ArrowRight')
  await waitFor('arrow key', `${pageName} === 'UNLOCKED TOUR'`)
  // Move to list, from the row's menu.
  const call = personal().find(t => t.title === 'Call the guide')
  await js(`document.querySelector('.todo-row[data-id="${call.id}"] [aria-label="Task actions"]').click()`); await delay(300)
  assert.ok(await js(`[...document.querySelectorAll('.todo-menu .todo-menu-head')].some(h => h.textContent === 'Move to list')`))
  await menuItem('Private')
  await waitFor('moved away', `JSON.stringify(${rows}) === '["Book the van"]'`)
  assert.equal(personal().find(t => t.id === call.id).list, undefined, 'back in the first list: no field')
  await js(`document.querySelector('.todo-sheet').focus()`); await key('ArrowLeft')
  await waitFor('moved here', `${pageName} === 'PRIVATE' && JSON.stringify(${rows}) === '["Buy milk","Call the guide"]'`)
  // Rename from the list's menu; the first list has no Delete.
  await click('[aria-label="List actions"]')
  assert.equal(await js(`[...document.querySelectorAll('.todo-menu button')].some(b => b.textContent === 'Delete list…')`), false)
  await menuItem('Rename')
  await waitFor('rename field', `document.activeElement?.classList.contains('todo-page-input')`)
  await win.webContents.insertText('General'); await key('Enter')
  await waitFor('renamed', `${pageName} === 'GENERAL' && document.querySelector('.todo-drop')?.textContent === 'General'`)
  // Delete list…: asked first, then gone with its tasks, and Undo brings it back.
  await click('[aria-label="Next list"]')
  await waitFor('tour page', `${pageName} === 'UNLOCKED TOUR'`)
  await delay(300)
  const shot = path.join(os.tmpdir(), 'terminai-todo-lists.png')
  fs.writeFileSync(shot, (await win.webContents.capturePage(undefined, { stayHidden: true })).toPNG())
  await click('[aria-label="List actions"]')
  await menuItem('Delete list…')
  await waitFor('question', `(document.querySelector('.todo-ask h2')?.textContent || '') === 'Delete the list “Unlocked Tour”?' && document.querySelector('.todo-ask-list')?.textContent === 'Book the van'`)
  await js(`document.querySelector('.todo-ask .btn.danger').click()`)
  await waitFor('deleted', `${pageName} === 'GENERAL' && !document.querySelector('.todo-page-count') && (document.querySelector('.todo-toast')?.textContent || '').startsWith('Deleted list “Unlocked Tour”')`)
  const cli = () => JSON.parse(execFileSync(process.execPath, [path.join(__dirname, '..', 'resources/terminai.cjs'), 'todo', '--personal'], { encoding: 'utf8', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', TERMINAI_TODO_DIR: dir } })).personal
  assert.deepEqual(cli().map(t => t.title).sort(), ['Buy milk', 'Call the guide'], 'a deleted list is out of terminai todo too')
  await js(`document.querySelector('.todo-toast button').click()`)
  await waitFor('undone', `${pageName} === 'UNLOCKED TOUR' && JSON.stringify(${rows}) === '["Book the van"]' && document.querySelector('.todo-page-count')?.textContent === '2 / 2'`)
  assert.deepEqual(cli().map(t => [t.title, t.list]).sort(), [['Book the van', 'Unlocked Tour'], ['Buy milk', 'General'], ['Call the guide', 'General']])
  // Reopened, the sheet shows the shared tasks; each list is in the view menu.
  await key('Escape'); await waitFor('closed', `!document.querySelector('.todo-sheet')`)
  await js(`document.querySelector('[aria-label^="To-do"]').click()`); await delay(600)
  await click('.todo-drop'); await menuItem('Unlocked Tour')
  await waitFor('picked from the menu', `${pageName} === 'UNLOCKED TOUR'`)
  console.log(`PASS todo lists: new list named in place, tasks typed into it, arrows and ← → between pages, Move to list, rename (also the first), Delete list asked then undone, list names in terminai todo · screenshot ${shot}`)
  fs.rmSync(dir, { recursive: true, force: true }); app.quit()
})().catch(e => { console.error(e); fs.rmSync(dir, { recursive: true, force: true }); app.exit(1) }) }))
setTimeout(() => { console.error('todo lists timeout'); app.exit(1) }, 100000).unref()
require(path.join(__dirname, '../out/main/index.js'))
