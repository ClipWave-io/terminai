// Settings › ManyMotions end to end: paste a connection code, check it, pick a folder, agree, connect, then a real Claude
// Code session in that folder shows in "See what is sent next" and "Send now" delivers it to the school.
// After `npx electron-vite build`:
//   CODEX_HOME=<scratch> TERMINAI_TEST_BUILD=1 EDU_CODE_FILE=<file with mm_tai_ code> EDU_FOLDER=<course folder> \
//   [EDU_BASE=http://localhost:3077] [EDU_SHOTS=<dir>] npx electron tests/edu-panel-ui.cjs
// EDU_FOLDER must be a folder of its own: the test runs one short `claude -p` there after connecting.
const { app, dialog } = require('electron'), fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert/strict'), { execFile } = require('child_process')
for (const k of ['CODEX_HOME', 'EDU_CODE_FILE', 'EDU_FOLDER']) if (!process.env[k]) { console.error(`Set ${k}.`); process.exit(1) }
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'terminai-edu-')); app.setPath('userData', dir)
fs.writeFileSync(path.join(dir, 'prefs.json'), JSON.stringify({ seenWelcome: true, tabs: [], voice: { enabled: false } }))
const code = fs.readFileSync(process.env.EDU_CODE_FILE, 'utf8').trim(), folder = process.env.EDU_FOLDER, base = process.env.EDU_BASE || ''
const shots = process.env.EDU_SHOTS || os.tmpdir()
const delay = ms => new Promise(r => setTimeout(r, ms))
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] })
const claude = () => new Promise((resolve, reject) => execFile('claude', ['-p', '--model', 'haiku', '--permission-mode', 'acceptEdits', 'Add a function sub(a, b) to add.py that returns a-b, then reply done.'], { cwd: folder, timeout: 150_000 }, e => e ? reject(e) : resolve()))
app.on('browser-window-created', (_e, win) => win.webContents.once('did-finish-load', () => { void (async () => {
  const js = c => win.webContents.executeJavaScript(c)
  const shot = async name => fs.writeFileSync(path.join(shots, name), (await win.webContents.capturePage(undefined, { stayHidden: true })).toPNG())
  const type = (sel, v) => js(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(el, ${JSON.stringify(v)}); el.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
  const click = label => js(`(() => { const b = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(label)} && !b.disabled); if (!b) return false; b.click(); return true })()`)
  const text = () => js(`document.querySelector('.settings-sheet, .st-page, body').innerText`)
  await delay(1500); win.setSize(1300, 900); await delay(300)
  win.webContents.send('settings:open', 'manymotions'); await delay(1200)
  assert.match(await text(), /ManyMotions for Education/, 'Settings › ManyMotions opens')
  if (base) { await js(`document.querySelectorAll('.st-page details, details').forEach(d => d.open = true)`); await delay(200); await type('input[placeholder="https://manymotions.org"]', base) }
  await type('input[placeholder="mm_tai_…"]', code); await delay(200)
  assert.ok(await click('Check'), 'Check button'); await delay(4000)
  const checked = await text()
  assert.doesNotMatch(checked, /does not work/, 'the code is accepted')
  await shot('tai-1-checked.png')
  await js(`(() => { const c = [...document.querySelectorAll('input[type=checkbox]')].find(x => !x.checked); if (c) c.click() })()`)
  assert.ok(await click('Add folder…'), 'Add folder'); await delay(600)
  assert.ok(await click('Connect'), 'Connect'); await delay(2500)
  assert.match(await text(), /Send now/, 'connected')
  await shot('tai-2-connected.png')
  await claude(); await delay(1000)
  assert.ok(await click('See what is sent next'), 'preview'); await delay(2500)
  assert.match(await text(), /add|sub|Claude/i, 'the new session is in the preview')
  await shot('tai-3-preview.png')
  assert.ok(await click('Send now'), 'Send now'); await delay(6000)
  const after = await text()
  assert.doesNotMatch(after, /answered [45]\d\d|stopped working|switched coding sessions off/, 'sent without an error')
  await shot('tai-4-sent.png')
  const cfg = fs.readdirSync(dir).find(f => /edu/i.test(f))
  console.log(`PASS edu panel: code checked, folder chosen, connected, real Claude Code session previewed and sent (${cfg || 'config'})`)
  fs.rmSync(dir, { recursive: true, force: true }); app.quit()
})().catch(async e => { console.error(e); try { fs.writeFileSync(path.join(shots, 'tai-fail.png'), (await win.webContents.capturePage(undefined, { stayHidden: true })).toPNG()) } catch {} fs.rmSync(dir, { recursive: true, force: true }); app.exit(1) }) }))
setTimeout(() => { console.error('edu panel timeout'); app.exit(1) }, 300_000).unref()
require(path.join(__dirname, '../out/main/index.js'))
