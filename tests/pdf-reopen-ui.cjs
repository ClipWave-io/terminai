// PDFs opened one after another, with Full size and Files closed in between: each one renders, and the window never
// shows "TerminAI hit a problem" (one shared pdf.js worker was destroyed by the first viewer to close).
// After `npx electron-vite build`: CODEX_HOME=<scratch dir> TERMINAI_TEST_BUILD=1 npx electron tests/pdf-reopen-ui.cjs
const { app } = require('electron'), fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert/strict'), { execFile } = require('child_process')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'terminai-pdfre-')); app.setPath('userData', dir)
fs.writeFileSync(path.join(dir, 'prefs.json'), JSON.stringify({ seenWelcome: true, tabs: [], voice: { enabled: false }, newTabAgent: 'none' }))
for (const n of ['a', 'b', 'c']) fs.copyFileSync(path.join(__dirname, 'fixtures', 'two-pages.pdf'), path.join(dir, `${n}.pdf`))
const delay = ms => new Promise(r => setTimeout(r, ms))
const cli = (...args) => new Promise(resolve => execFile(process.execPath, [path.join(__dirname, '..', 'resources/terminai.cjs'), ...args], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', TERMINAI_CONTROL: path.join(dir, 'control.json') } }, (e, out, err) => resolve({ ok: !e, err: String(err) })))
app.on('browser-window-created', (_e, win) => win.webContents.once('did-finish-load', () => { void (async () => {
  const js = code => win.webContents.executeJavaScript(code)
  await delay(1500); win.setSize(1400, 860)
  const crashed = () => js(`/hit a problem/.test(document.body.innerText)`)
  const rendered = async name => { for (let i = 0; i < 40; i++) { if (await crashed()) throw new Error(`crashed opening ${name}: ` + await js(`document.body.innerText.slice(0, 300)`)); if (await js(`/of 2/.test(document.querySelector('.pdf-page')?.textContent || '') && (document.querySelector('.pdf-pages canvas')?.width || 0) > 0`)) return; await delay(250) } throw new Error(`${name} did not render`) }
  for (let round = 0; round < 3; round++) for (const n of ['a', 'b', 'c']) {
    const r = await cli('show', path.join(dir, `${n}.pdf`)); assert.ok(r.ok, r.err)
    await rendered(`${n}.pdf (round ${round + 1})`)
    if (n === 'b') { await js(`document.querySelector('[aria-label="Full size"]').click()`); await rendered('b.pdf full size') }
    if (n === 'c') { await js(`document.querySelector('[aria-label="Close files"]')?.click()`); await delay(300) }
  }
  // Switching before the last one has loaded: the previous viewer is still being torn down when the next starts.
  for (let i = 0; i < 12; i++) { void cli('show', path.join(dir, `${'abc'[i % 3]}.pdf`)); await delay(60 + (i % 4) * 40) }
  await delay(1500); await rendered('quick switching')
  for (let i = 0; i < 6; i++) { await js(`document.querySelector('[aria-label="Full size"]')?.click()`); await delay(30); await js(`document.querySelector('[aria-label="Close files"]')?.click()`); void cli('show', path.join(dir, 'a.pdf')); await delay(120) }
  await delay(1500); await rendered('full size and close in a burst')
  assert.equal(await crashed(), false)
  console.log('PASS pdf reopen: nine PDFs in a row, full size and closing between them, all render with no crash'); app.exit(0)
})().catch(e => { console.error(e); app.exit(1) }) }))
setTimeout(() => { console.error('timeout'); app.exit(1) }, 90000).unref(); require('../out/main/index.js')
