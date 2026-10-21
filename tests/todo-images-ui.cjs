// Images under a task's note: a screenshot pasted into the note, a big picture made small, the thumbnail,
// the Files pane on click, the other Mac's copy through the repo, and ×.
// After `npx electron-vite build`: CODEX_HOME=<scratch dir> TERMINAI_TEST_BUILD=1 npx electron tests/todo-images-ui.cjs
const electron = require('electron'), { app } = electron, fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert/strict'), { execFileSync } = require('child_process')
if (!process.env.CODEX_HOME) { console.error('Set CODEX_HOME to a scratch folder: the app writes its Codex config there.'); process.exit(1) }
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'terminai-todo-images-')), bare = path.join(root, 'tasks.git'), ilai = path.join(root, 'ilai')
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
git(root, 'init', '-q', '--bare', '-b', 'main', bare); git(root, 'clone', '-q', bare, ilai)
fs.mkdirSync(path.join(ilai, 'tasks')); fs.writeFileSync(path.join(ilai, 'tasks/.gitkeep'), ''); git(ilai, 'add', '-A'); git(ilai, 'commit', '-q', '-m', 'seed'); git(ilai, 'push', '-q', 'origin', 'HEAD:main')
const dir = path.join(root, 'userData'); fs.mkdirSync(dir); app.setPath('userData', dir)
fs.writeFileSync(path.join(dir, 'prefs.json'), JSON.stringify({ seenWelcome: true, tabs: [], voice: { enabled: false }, tasksUser: 'livio' }))
process.env.TERMINAI_TASKS_REMOTE = `file://${bare}`
const delay = ms => new Promise(r => setTimeout(r, ms))
app.on('browser-window-created', (_e, win) => win.webContents.once('did-finish-load', () => { void (async () => {
  const js = code => win.webContents.executeJavaScript(code)
  const waitFor = async (what, code, ms = 8000) => { for (const t = Date.now(); Date.now() - t < ms; await delay(150)) if (await js(code)) return; throw new Error(`timeout: ${what}`) }
  await delay(1200); win.setSize(1400, 860); await delay(300)
  const list = await js(`window.term.todos.save('shared', { title: 'Logo looks wrong', notes: 'See the screenshot', assignee: 'both' })`)
  const id = list.shared[0].id
  await js(`document.querySelector('[aria-label^="To-do"]').click()`); await delay(900)
  // A Retina-size screenshot on the clipboard, pasted into the note.
  await js(`document.querySelector('.todo-row[data-id="${id}"] .todo-note-text').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 1, clientY: 1 }))`)
  await waitFor('note editor', `!!document.querySelector('.todo-row[data-id="${id}"] .todo-notes')`)
  await js(`(async () => {
    const c = document.createElement('canvas'); c.width = 2940; c.height = 1912
    const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.fillStyle = '#222'; g.font = '64px sans-serif'
    for (let y = 80; y < c.height; y += 90) g.fillText('Logo looks wrong on the pricing page, line ' + y, 40, y)
    const blob = await new Promise(r => c.toBlob(r, 'image/png'))
    const dt = new DataTransfer(); dt.items.add(new File([blob], 'Screenshot.png', { type: 'image/png' }))
    document.querySelector('.todo-row[data-id="${id}"] .todo-notes').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
  })()`)
  await waitFor('thumbnail', `!!document.querySelector('.todo-row[data-id="${id}"] .todo-image img[src^="data:image/"]')`, 15000)
  const task = (await js(`window.term.todos.list()`)).shared.find(t => t.id === id)
  assert.equal(task.images.length, 1)
  const name = task.images[0], file = path.join(dir, 'build-tasks', 'images', id, name)
  const size = electron.nativeImage.createFromPath(file).getSize()
  assert.equal(Math.max(size.width, size.height), 2000, `made small: ${JSON.stringify(size)}`)
  assert.ok(fs.statSync(file).size <= 1.5 * 1024 * 1024, `small enough for the repo: ${fs.statSync(file).size} bytes`)
  assert.equal(task.notes, 'See the screenshot', 'the note text is untouched')
  // The other Mac gets the picture with the task.
  git(ilai, 'pull', '-q', '--rebase')
  assert.ok(fs.readFileSync(path.join(ilai, 'images', id, name)).equals(fs.readFileSync(file)), 'in the repo, byte for byte')
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(ilai, 'tasks', `${id}.json`), 'utf8')).images, [name])
  // The CLI sessions read gives the path to look at.
  const cli = JSON.parse(execFileSync(process.execPath, [path.join(__dirname, '..', 'resources/terminai.cjs'), 'todo', '--shared'], { encoding: 'utf8', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', TERMINAI_TODO_DIR: dir, TERMINAI_TASKS_DIR: path.join(dir, 'build-tasks', 'tasks') } }))
  assert.deepEqual(cli.shared.find(t => t.id === id).imageFiles, [file])
  // A click shows it whole over the sheet; Esc closes it and leaves the sheet open.
  await js(`document.querySelector('.todo-row[data-id="${id}"] .todo-image-open').click()`)
  await waitFor('image over the sheet', `(() => { const i = document.querySelector('.todo-lightbox img[src^="data:image/"]'); return !!i && i.complete && i.naturalWidth === 2000 })()`)
  await delay(400)
  fs.writeFileSync(path.join(os.tmpdir(), 'terminai-todo-images.png'), (await win.webContents.capturePage(undefined, { stayHidden: true })).toPNG())
  await js(`document.querySelector('.todo-lightbox').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`); await delay(300)
  assert.equal(await js(`!!document.querySelector('.todo-lightbox')`), false, 'Esc closes the image')
  assert.equal(await js(`!!document.querySelector('.todo-sheet')`), true, 'and only the image')
  // "Open in the Files pane" puts it there and closes the sheet, so it is in view.
  await js(`document.querySelector('.todo-row[data-id="${id}"] .todo-image-open').click()`)
  await waitFor('image again', `!!document.querySelector('.todo-lightbox .btn')`)
  await js(`[...document.querySelectorAll('.todo-lightbox .btn')].find(b => b.textContent === 'Open in the Files pane').click()`)
  await waitFor('Files pane', `(document.querySelector('.file-preview-title')?.textContent || '').includes(${JSON.stringify(name)}) && !document.querySelector('.todo-sheet')`, 10000)
  fs.writeFileSync(path.join(os.tmpdir(), 'terminai-todo-images-files.png'), (await win.webContents.capturePage(undefined, { stayHidden: true })).toPNG())
  // × takes it off, here and in the repo.
  await js(`document.querySelector('[aria-label^="To-do"]').click()`); await delay(800)
  await js(`document.querySelector('.todo-row[data-id="${id}"] .todo-image-remove').click()`)
  await waitFor('image removed', `!document.querySelector('.todo-row[data-id="${id}"] .todo-image')`)
  git(ilai, 'pull', '-q', '--rebase')
  assert.equal(fs.existsSync(path.join(ilai, 'images', id, name)), false)
  console.log(`PASS todo images: pasted screenshot made ${size.width}x${size.height} (${Math.round(fs.statSync(path.join(ilai, '..', 'userData', 'build-tasks', 'tasks', `${id}.json`)).size)} B task file), thumbnail, in the repo for the other Mac, imageFiles in terminai todo, opens in the Files pane, × removes it everywhere · screenshot ${path.join(os.tmpdir(), 'terminai-todo-images.png')}`)
  fs.rmSync(root, { recursive: true, force: true }); app.quit()
})().catch(e => { console.error(e); fs.rmSync(root, { recursive: true, force: true }); app.exit(1) }) }))
setTimeout(() => { console.error('todo images timeout'); app.exit(1) }, 90000).unref()
require(path.join(__dirname, '../out/main/index.js'))
