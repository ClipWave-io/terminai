// Long input into a tab must never freeze the app: a `terminai open` command of several KB, and a
// `terminai send` into a tab whose program is not reading. 21/10/2026: a 5 KB open hung the window
// until a force quit, the main thread spinning in write() on the pty.
// After `npx electron-vite build`: CODEX_HOME=<scratch dir> TERMINAI_TEST_BUILD=1 npx electron tests/pty-write-ui.cjs
// A frozen main thread cannot run its own timeout: run it under `perl -e 'alarm 120; exec @ARGV'`.
const { app } = require('electron'), fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert/strict'), crypto = require('crypto'), { execFile } = require('child_process')
if (!process.env.CODEX_HOME) { console.error('Set CODEX_HOME to a scratch folder: the app writes its Codex config there.'); process.exit(1) }
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'terminai-ptywrite-')); app.setPath('userData', dir)
fs.writeFileSync(path.join(dir, 'prefs.json'), JSON.stringify({ seenWelcome: true, tabs: [], voice: { enabled: false } }))
const delay = ms => new Promise(r => setTimeout(r, ms))
// Never execFileSync here: the control server answers from this very process.
const cli = (...args) => new Promise(resolve => execFile(process.execPath, [path.join(__dirname, '..', 'resources/terminai.cjs'), ...args], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', TERMINAI_CONTROL: path.join(dir, 'control.json') } }, (e, out, err) => resolve({ ok: !e, out: String(out), err: String(err) })))
// The longest the main thread went without running a timer.
let lag = 0, last = Date.now()
setInterval(() => { const now = Date.now(); lag = Math.max(lag, now - last - 50); last = now }, 50)
app.on('browser-window-created', (_e, win) => win.webContents.once('did-finish-load', () => { void (async () => {
  await delay(1500)
  // 12 KB with spaces and quotes, through the shell into a file: it must arrive whole.
  const words = []; for (let i = 0; words.join(' ').length < 12000; i++) words.push(`w${i}'q"${i % 7}`)
  const big = words.join(' '), out = path.join(dir, 'sha.txt')
  lag = 0
  let r = await cli('open', '--cwd', dir, '--name', 'long', '--', 'sh', '-c', `printf %s "$1" | shasum -a 256 > '${out}'`, '_', big)
  assert.ok(r.ok, r.err)
  const longId = JSON.parse(r.out).id
  for (let t = Date.now(); !fs.existsSync(out) || !fs.readFileSync(out, 'utf8').trim(); await delay(200)) if (Date.now() - t > 30000) throw new Error(`the long command never ran; the tab shows:\n${(await cli('read', longId, '--lines', '30')).out.slice(-3000)}`)
  assert.equal(fs.readFileSync(out, 'utf8').split(' ')[0], crypto.createHash('sha256').update(big).digest('hex'), 'the command arrived whole')
  assert.ok(lag < 1000, `the window stalled ${lag} ms while a long command was typed`)
  const typed = lag
  // A program that does not read: 40 KB sent while it sleeps. The app must keep answering.
  r = await cli('open', '--cwd', dir, '--name', 'busy', '--command', 'sleep 6'); assert.ok(r.ok, r.err)
  const id = JSON.parse(r.out).id
  await delay(2500)
  lag = 0
  const sent = cli('send', id, `: ${'a'.repeat(40000)}`)
  await delay(1000)
  const t = Date.now(); r = await cli('list'); const listMs = Date.now() - t
  assert.ok(r.ok, r.err); assert.ok(listMs < 2000, `list took ${listMs} ms while a send was queued`)
  r = await sent; assert.ok(r.ok, r.err)
  assert.ok(lag < 1000, `the window stalled ${lag} ms while a sleeping tab was sent 40 KB`)
  console.log(`PASS pty writes: 12 KB open arrived whole (max stall ${typed} ms); 40 KB sent to a sleeping tab, list answered in ${listMs} ms (max stall ${lag} ms)`)
  fs.rmSync(dir, { recursive: true, force: true }); app.quit()
})().catch(e => { console.error(e); fs.rmSync(dir, { recursive: true, force: true }); app.exit(1) }) }))
setTimeout(() => { console.error('pty write timeout'); app.exit(1) }, 90000).unref()
require(path.join(__dirname, '../out/main/index.js'))
