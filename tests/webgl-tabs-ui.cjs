// Many tabs must not use up the GPU: only the visible terminal draws with WebGL, so the open tab never loses its
// context (12/11/2026: with ~50 tabs, closing a file in Files left a white box with a broken-image icon).
// After `npx electron-vite build`: CODEX_HOME=<scratch> TERMINAI_TEST_BUILD=1 npx electron tests/webgl-tabs-ui.cjs
const { app } = require('electron'), fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert/strict')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'terminai-webgl-')); app.setPath('userData', dir)
const tabs = Array.from({ length: 24 }, (_, i) => ({ cwd: os.tmpdir(), title: `t${i}`, customTitle: `Tab ${i}`, notes: '', focusedMs: 0 }))
fs.writeFileSync(path.join(dir, 'prefs.json'), JSON.stringify({ seenWelcome: true, tabs, voice: { enabled: false }, newTabAgent: 'none' }))
const delay = ms => new Promise(r => setTimeout(r, ms))
app.on('browser-window-created', (_e, win) => win.webContents.once('did-finish-load', () => { void (async () => {
  const js = s => win.webContents.executeJavaScript(s)
  for (let i = 0; i < 60 && await js(`document.querySelectorAll('.term-host').length`) < 24; i++) await delay(250)
  const gl = `[...document.querySelectorAll('.term-host')].filter(h=>[...h.querySelectorAll('canvas')].some(c=>c.getContext('webgl2')&&!c.getContext('webgl2').isContextLost())).length`
  // Walk every tab: the open one draws with WebGL, the hidden ones let theirs go.
  for (let i = 0; i < 24; i++) { await js(`[...document.querySelectorAll('.rail .tab')][${i}]?.click()`); await delay(120) }
  await delay(2000)
  const n = await js(gl)
  assert.ok(n >= 1 && n <= 2, `WebGL terminals after visiting 24 tabs: ${n} (only the open one should hold one)`)
  assert.ok(await js(`!!document.querySelector('.term-host.active canvas')`), 'the open terminal draws')
  console.log(`PASS webgl: 24 tabs visited, ${n} WebGL terminal(s) left, the open one draws`); app.quit()
})().catch(e => { console.error(e); app.exit(1) }) }))
setTimeout(() => app.exit(1), 90000).unref(); require('../out/main/index.js')
