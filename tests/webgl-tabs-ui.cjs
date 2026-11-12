// Terminals draw without WebGL, so none can lose a GPU context (12/11/2026: with ~50 tabs, closing a file in Files left a white box with a broken-image icon).
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
  assert.equal(n, 0, `no terminal holds a WebGL context (${n} do)`)
  assert.ok(await js(`document.querySelector('.term-host.active .xterm-rows')?.textContent.length>0`), 'the open terminal draws its text')
  // Hovering a row: the buttons sit inside it and the text makes room for them.
  const r = JSON.parse(await js(`JSON.stringify(document.querySelector('.rail .tab.active').getBoundingClientRect())`))
  win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(r.x + r.width - 20), y: Math.round(r.y + r.height / 2) }); await delay(400)
  const inside = await js(`(()=>{const t=document.querySelector('.rail .tab.active').getBoundingClientRect(),b=document.querySelector('.rail .tab.active .tab-hide').getBoundingClientRect();return b.top>=t.top&&b.bottom<=t.bottom&&b.right<=t.right})()`)
  assert.ok(inside, 'the hover buttons sit inside the row')
  if (process.env.SHOTS) { win.show(); win.webContents.invalidate(); await delay(800); fs.writeFileSync(path.join(process.env.SHOTS, 'rail-hover.png'), (await win.webContents.capturePage({ x: 0, y: 0, width: 420, height: 300 })).toPNG()) }
  console.log(`PASS webgl: 24 tabs visited, ${n} WebGL terminal(s) left, the open one draws`); app.quit()
})().catch(e => { console.error(e); app.exit(1) }) }))
setTimeout(() => app.exit(1), 90000).unref(); require('../out/main/index.js')
