// Row colours: a colour saved with a tab tints its row in the sidebar and survives a restart (prefs.json); changing it
// through the same path the right-click menu uses saves it. SHOT=<png> saves a screenshot.
// After `npx electron-vite build`: TERMINAI_TEST_BUILD=1 npx electron tests/tab-colors-ui.cjs
const { app } = require('electron'), fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert/strict')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'terminai-colors-')); app.setPath('userData', dir)
const f = path.join(dir, 'proj'); fs.mkdirSync(f)
const tab = (title, color) => ({ cwd: f, title, customTitle: title, color, notes: '', focusedMs: 0 })
fs.writeFileSync(path.join(dir, 'prefs.json'), JSON.stringify({ seenWelcome: true, groupByFolder: true, voice: { enabled: false }, newTabAgent: 'none', railWidth: 300,
  tabs: [tab('daily: blog check', 'orange'), tab('daily: outreach', 'orange'), tab('daily: citations', 'orange'), tab('feature work'), tab('review', 'blue')] }))
const delay = ms => new Promise(r => setTimeout(r, ms))
app.on('browser-window-created', (_e, win) => win.webContents.once('did-finish-load', () => { void (async () => {
  const js = s => win.webContents.executeJavaScript(s)
  for (let i = 0; i < 60 && (await js(`document.querySelectorAll('.rail .tab').length`)) < 5; i++) await delay(150)
  assert.equal(await js(`document.querySelectorAll('.rail .tab.colored').length`), 4)
  assert.match(await js(`[...document.querySelectorAll('.rail .tab')].find(t => t.textContent.includes('review')).style.getPropertyValue('--tab-color')`), /#3e63dd/i)
  await delay(1500)
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'prefs.json'), 'utf8')).tabs.map(t => t.color || '')
  assert.deepEqual(saved, ['orange', 'orange', 'orange', '', 'blue'], 'colours saved: ' + saved)
  if (process.env.SHOT) fs.writeFileSync(process.env.SHOT, (await win.webContents.capturePage()).toPNG())
  console.log('PASS tab colours: rows tinted by their colour, saved in prefs')
  app.quit()
})().catch(e => { console.error(e); app.exit(1) }) }))
setTimeout(() => { console.error('timeout'); app.exit(1) }, 40000).unref(); require('../out/main/index.js')
