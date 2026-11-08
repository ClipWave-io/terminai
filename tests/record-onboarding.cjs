// Records the first launch of a fresh install as PNG frames (FRAMES dir): the welcome steps, then the To-do without an account.
const electron = require('electron'), { app } = electron, fs = require('fs'), os = require('os'), path = require('path')
const out = process.env.FRAMES, root = fs.mkdtempSync(path.join(os.tmpdir(), 'terminai-onboard-')), dir = path.join(root, 'userData')
fs.mkdirSync(dir); app.setPath('userData', dir)
const delay = ms => new Promise(r => setTimeout(r, ms))
let n = 0
app.on('browser-window-created', (_e, win) => win.webContents.once('did-finish-load', () => { void (async () => {
  const js = code => win.webContents.executeJavaScript(code)
  let rec = true
  const loop = async () => { while (rec) { try { fs.writeFileSync(path.join(out, `f${String(n++).padStart(5, '0')}.png`), (await win.webContents.capturePage(undefined, { stayHidden: true })).toPNG()) } catch {} await delay(120) } }
  win.setSize(1440, 900); await delay(1500); void loop()
  const click = async (sel, text) => { await js(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(sel)})].find(x => ${text ? `x.textContent.includes(${JSON.stringify(text)})` : 'true'}); b && b.click(); return !!b })()`) }
  const scroll = async (sel, steps) => { for (let i = 0; i < steps; i++) { await js(`document.querySelector(${JSON.stringify(sel)})?.scrollBy({top: 140, behavior: 'smooth'})`); await delay(450) } }
  try {
    await delay(4200)                                                   // welcome, the terminal typing
    await click('.onb button', 'Get started'); await delay(3200)       // notes, tasks and agent logs
    await click('.onb button', 'Skip for now'); await delay(3000)      // LocalFlow
    await click('.onb button', 'Start using TerminAI'); await delay(1500)
    await click('.todo-button'); await delay(1800)                      // the To-do: private lists, no account
    await js(`(() => { const r = [...document.querySelectorAll('.todo-sheet textarea, .todo-sheet input')].find(x => x.offsetParent); r && r.focus(); return !!r })()`); await delay(300)
    await win.webContents.insertText('Ship the landing page'); await delay(400); win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' }); await delay(1500)
    await click('.todo-seg button', 'Log'); await delay(2400)
    await click('.todo-head-close'); await delay(1200)
  } finally { rec = false; await delay(300); console.log(`frames ${n}`); fs.rmSync(root, { recursive: true, force: true }); app.exit(0) }
})() }))
require(path.join(__dirname, '../out/main/index.js'))
