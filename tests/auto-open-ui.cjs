// Files opens by itself or not (Settings › Files open by themselves, and a conversation's own choice): with it off, an
// agent's `terminai show` leaves the view as it is and a note says the file is ready in Files.
// After `npx electron-vite build`: TERMINAI_TEST_BUILD=1 npx electron tests/auto-open-ui.cjs
const { app } = require('electron'), fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert/strict'), { execFile } = require('child_process')
const REPO = path.join(__dirname, '..')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'terminai-auto-')); app.setPath('userData', dir)
fs.writeFileSync(path.join(dir, 'prefs.json'), JSON.stringify({ seenWelcome: true, tabs: [], voice: { enabled: false }, newTabAgent: 'none', autoShowFiles: false }))
const note = path.join(dir, 'report.txt'); fs.writeFileSync(note, 'hello')
const delay = ms => new Promise(r => setTimeout(r, ms))
const cli = (env, ...args) => new Promise((resolve, reject) => execFile(process.execPath, [path.join(REPO, 'resources/terminai.cjs'), ...args], { env: { ...process.env, ...env, ELECTRON_RUN_AS_NODE: '1', TERMINAI_CONTROL: path.join(dir, 'control.json') } }, (e, out, err) => e ? reject(new Error(err || e.message)) : resolve(String(out))))
app.on('browser-window-created', (_e, win) => win.webContents.once('did-finish-load', () => { void (async () => {
  const js = s => win.webContents.executeJavaScript(s)
  for (let i = 0; i < 50 && !fs.existsSync(path.join(dir, 'control.json')); i++) await delay(200)
  const { id } = JSON.parse(await cli({}, 'open', '--cwd', dir, '--name', 'agent')); await cli({}, 'focus', id); await delay(600)
  const filesShown = () => js(`(() => { const f = document.querySelector('.files-slot'); return !!f && !f.classList.contains('workspace-hidden') })()`)
  await cli({ TERMINAI_TAB_ID: id }, 'show', note); await delay(800)
  assert.equal(await filesShown(), false, 'Files stays closed')
  assert.match(await js(`document.querySelector('.toast')?.textContent || ''`), /report\.txt is ready in Files/)
  // The person's own `terminai show` (no tab) still opens it.
  await cli({}, 'show', note); await delay(800)
  assert.equal(await filesShown(), true, 'opened when not from an agent tab')
  console.log('PASS auto open: with Files set not to open by itself, an agent\'s file waits with a note')
  await cli({}, 'close', id).catch(() => {}); app.quit()
})().catch(e => { console.error(e); app.exit(1) }) }))
setTimeout(() => { console.error('timeout'); app.exit(1) }, 40000).unref(); require('../out/main/index.js')
