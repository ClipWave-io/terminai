// Right-click in the Files pane: Finder's menu. The test stands in for the native menu (it records the items and
// "clicks" one), then checks what happened on disk: rename in place, new folder, new file, duplicate, compress, trash.
// After `npx electron-vite build`: CODEX_HOME=<scratch dir> TERMINAI_TEST_BUILD=1 npx electron tests/files-menu-ui.cjs
const { app, Menu, shell } = require('electron'), fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert/strict')
if (!process.env.CODEX_HOME) { console.error('Set CODEX_HOME to a scratch folder.'); process.exit(1) }
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'terminai-files-menu-')); app.setPath('userData', dir)
fs.writeFileSync(path.join(dir, 'prefs.json'), JSON.stringify({ seenWelcome: true, tabs: [], voice: { enabled: false } }))
const docs = path.join(dir, 'project'); fs.mkdirSync(docs); fs.writeFileSync(path.join(docs, 'notes.md'), '# Notes\n')
const delay = ms => new Promise(r => setTimeout(r, ms))
let pick = null, labels = []
Menu.prototype.popup = function (options) {
  labels = this.items.filter(i => i.type !== 'separator').map(i => i.role === 'sharemenu' || i.role === 'shareMenu' ? 'Share' : i.label)
  const item = this.items.find(i => i.label === pick)
  if (item) item.click()
  setTimeout(() => options?.callback?.(), 30)
}
const trashed = []; shell.trashItem = async p => { trashed.push(p); fs.rmSync(p, { recursive: true }) }
app.on('browser-window-created', (_e, win) => win.webContents.once('did-finish-load', () => { void (async () => {
  const js = code => win.webContents.executeJavaScript(code)
  const names = () => js(`[...document.querySelectorAll('.files-tree button[title]')].map(b => b.title)`)
  const right = async (title, label) => {
    pick = label
    const target = title ? `.files-tree button[title="${title}"]` : '.files-tree'
    await js(`document.querySelector(${JSON.stringify(target)}).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))`); await delay(500)
  }
  const type = async value => { await js(`(() => { const el = document.querySelector('.files-name'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })()`); await delay(700) }
  await delay(1500); win.setSize(1400, 860)
  app.emit('open-file', { preventDefault() {} }, path.join(docs, 'notes.md')); await delay(2500)
  assert.deepEqual(await names(), ['notes.md'])

  await right('notes.md', null)
  assert.deepEqual(labels, ['Open', 'Open With Default App', 'Move to Trash', 'Get Info', 'Rename…', 'Compress “notes.md”', 'Duplicate', 'Quick Look', 'Copy “notes.md”', 'Copy Path', 'Share', 'Show in Finder', 'New Folder', 'New File'])
  await right('notes.md', 'Rename…')
  assert.equal(await js(`document.querySelector('.files-name').value`), 'notes.md')
  await type('plan.md')
  assert.deepEqual(fs.readdirSync(docs).sort(), ['plan.md'])
  await right(null, 'New Folder'); await type('assets')
  await right(null, 'New File'); await type('todo.txt')
  assert.deepEqual(fs.readdirSync(docs).sort(), ['assets', 'plan.md', 'todo.txt'])
  assert.match(await js(`document.querySelector('.file-preview-title')?.textContent || ''`), /todo\.txt/, 'a new file opens')
  await right('plan.md', 'Duplicate'); await right('plan.md', 'Duplicate')
  await right('plan.md', 'Compress “plan.md”'); await delay(800)
  assert.deepEqual(fs.readdirSync(docs).sort(), ['assets', 'plan copy 2.md', 'plan copy.md', 'plan.md', 'plan.md.zip', 'todo.txt'])
  // Names that would leave the folder or clash are refused, with the reason shown.
  await right('todo.txt', 'Rename…'); await type('../escape.txt')
  assert.match(await js(`document.querySelector('.files-status').textContent`), /without \/ or :/)
  await right('todo.txt', 'Rename…'); await type('plan.md')
  assert.match(await js(`document.querySelector('.files-status').textContent`), /already exists/)
  await right('plan copy 2.md', 'Move to Trash')
  assert.equal(path.basename(trashed[0]), 'plan copy 2.md'); assert.equal(fs.existsSync(path.join(docs, 'plan copy 2.md')), false)
  assert.deepEqual(await names(), ['assets', 'plan copy.md', 'plan.md', 'plan.md.zip', 'todo.txt'])
  await right(null, null)
  assert.deepEqual(labels, ['New Folder', 'New File', 'Show in Finder', 'Copy Path'], 'empty space: the folder menu')
  console.log('PASS files menu: Finder items, rename in place, new folder and file, duplicate, compress, trash, bad names refused')
  fs.rmSync(dir, { recursive: true, force: true }); app.exit(0)
})().catch(e => { console.error(e); app.exit(1) }) }))
setTimeout(() => { console.error('files menu UI timeout'); app.exit(1) }, 45000).unref()
require(path.join(__dirname, '../out/main/index.js'))
