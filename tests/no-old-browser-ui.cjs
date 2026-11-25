// The old built-in browser pane never shows, even for someone who had turned it on (browserBeta saved as true):
// the browser button opens TerminAI Browser's pane instead. After `npx electron-vite build`: TERMINAI_TEST_BUILD=1 npx electron tests/no-old-browser-ui.cjs
const { app } = require('electron'), fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert/strict')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'terminai-nooldbrowser-')); app.setPath('userData', dir)
fs.writeFileSync(path.join(dir, 'prefs.json'), JSON.stringify({ seenWelcome: true, browserBeta: true, tabs: [], voice: { enabled: false }, newTabAgent: 'none' }))
const delay = ms => new Promise(r => setTimeout(r, ms))
app.on('browser-window-created', (_e, win) => win.webContents.once('did-finish-load', () => { void (async () => {
  const js = s => win.webContents.executeJavaScript(s)
  for (let i = 0; i < 50 && !(await js(`!!document.querySelector('[aria-label="Browser"]')`)); i++) await delay(200)
  await js(`window.term.browser.action('session', { owner: 'x' }).catch(() => null)`)
  await js(`document.querySelector('[aria-label="Browser"]').click()`); await delay(800)
  assert.equal(await js(`!!document.querySelector('.browser-pane:not(.full-browser)')`), false, 'no old browser pane')
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'prefs.json'), 'utf8')).browserBeta ?? false, false)
  console.log('PASS no old browser: the old pane never shows, even with browserBeta saved on')
  app.quit()
})().catch(e => { console.error(e); app.exit(1) }) }))
setTimeout(() => { console.error('timeout'); app.exit(1) }, 40000).unref(); require('../out/main/index.js')
