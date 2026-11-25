// ⌘F: the find bar searches inside the conversation in view (its terminal scrollback) and the same words filter the
// sidebar titles; Esc closes it. SHOT=<png> saves a screenshot. After `npx electron-vite build`: TERMINAI_TEST_BUILD=1 npx electron tests/find-ui.cjs
const { app } = require('electron'), fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert/strict'), { execFile } = require('child_process')
const REPO = path.join(__dirname, '..')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'terminai-find-')); app.setPath('userData', dir)
fs.writeFileSync(path.join(dir, 'prefs.json'), JSON.stringify({ seenWelcome: true, tabs: [], voice: { enabled: false }, newTabAgent: 'none' }))
const delay = ms => new Promise(r => setTimeout(r, ms))
const waitFor = async (what, fn, ms) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return; await delay(200) } throw new Error('timed out: ' + what) }
const cli = (...args) => new Promise((resolve, reject) => execFile(process.execPath, [path.join(REPO, 'resources/terminai.cjs'), ...args], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', TERMINAI_CONTROL: path.join(dir, 'control.json') } }, (e, out, err) => e ? reject(new Error(err || e.message)) : resolve(String(out))))
app.on('browser-window-created', (_e, win) => win.webContents.once('did-finish-load', () => { void (async () => {
  const js = s => win.webContents.executeJavaScript(s)
  await waitFor('control', () => fs.existsSync(path.join(dir, 'control.json')), 10000)
  const a = JSON.parse(await cli('open', '--cwd', dir, '--name', 'alpha notes', '--command', 'echo needle-one; echo hay; echo needle-two')).id
  JSON.parse(await cli('open', '--cwd', dir, '--name', 'beta other'))
  await cli('focus', a)
  await waitFor('output', async () => /needle-two/.test(JSON.parse(await cli('read', a)).text), 10000)
  await js(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', metaKey: true, bubbles: true }))`)
  await waitFor('find bar', () => js(`!!document.querySelector('.find-bar input')`), 3000)
  const type = q => js(`(() => { const t = document.querySelector('.find-bar input'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(t, ${JSON.stringify(q)}); t.dispatchEvent(new Event('input', { bubbles: true })) })()`)
  await type('needle')
  await waitFor('matches in the terminal', async () => /of [2-9]/.test(await js(`document.querySelector('.find-count').textContent`)), 5000)
  await type('alpha')
  await waitFor('titles filtered', async () => (await js(`[...document.querySelectorAll('.rail .tab-title')].map(e => e.textContent).join('|')`)) === 'alpha notes', 5000)
  await type('needle'); await delay(400)
  assert.equal(await js(`document.querySelectorAll('.rail .tab').length`), 3, 'no title matches: the sidebar keeps every conversation')
  if (process.env.SHOT) { fs.writeFileSync(process.env.SHOT, (await win.webContents.capturePage()).toPNG()) }
  await js(`document.querySelector('.find-bar input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
  await waitFor('closed', () => js(`!document.querySelector('.find-bar') && document.querySelectorAll('.rail .tab').length === 3`), 3000)
  console.log('PASS find: ⌘F searches inside the conversation and filters the titles; Esc closes')
  app.quit()
})().catch(e => { console.error(e); app.exit(1) }) }))
setTimeout(() => { console.error('timeout'); app.exit(1) }, 60000).unref(); require('../out/main/index.js')
