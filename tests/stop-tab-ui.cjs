// Stop / Resume on a session row: Stop ends the (fake) claude so its memory is freed, the row shows asleep with a
// Resume button, opening the tab does not bring it back, and Resume runs `claude --resume <same id>` in the same tab.
// After `npx electron-vite build`: TERMINAI_TEST_BUILD=1 npx electron tests/stop-tab-ui.cjs
process.env.TERMINAI_TEST_ALLOW_AGENTS = '1'
const { app } = require('electron'), fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto'), assert = require('assert/strict'), { execFileSync, execFile } = require('child_process')
const REPO = path.join(__dirname, '..')
const PROJ = path.join(os.homedir(), '.claude', 'projects', `-terminai-stop-test-${process.pid}`); fs.mkdirSync(PROJ, { recursive: true })
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'terminai-stop-'))
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'terminai-stop-data-')); app.setPath('userData', dir)
fs.writeFileSync(path.join(dir, 'prefs.json'), JSON.stringify({ seenWelcome: true, tabs: [], voice: { enabled: false }, newTabAgent: 'none' }))
const delay = ms => new Promise(r => setTimeout(r, ms))
const waitFor = async (what, fn, ms) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return; await delay(250) } throw new Error('timed out: ' + what) }
const LOG = path.join(WORK, 'fake.log'), SID = crypto.randomUUID()
const starts = () => { try { return fs.readFileSync(LOG, 'utf8').split('\n').filter(l => l.startsWith('start ')) } catch { return [] } }
const fakes = () => { try { return execFileSync('/usr/bin/pgrep', ["-f", `^claude .*${SID}`]).toString().trim().split('\n').filter(Boolean) } catch { return [] } }
const cli = (...args) => new Promise((resolve, reject) => execFile(process.execPath, [path.join(REPO, 'resources/terminai.cjs'), ...args], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', TERMINAI_CONTROL: path.join(dir, 'control.json') } }, (e, out, err) => e ? reject(new Error(err || e.message)) : resolve(String(out))))

app.on('browser-window-created', (_e, win) => win.webContents.once('did-finish-load', () => { void (async () => {
  const js = s => win.webContents.executeJavaScript(s)
  fs.mkdirSync(path.join(WORK, 'fakebin'))
  execFileSync('clang', ['-O1', '-o', path.join(WORK, 'fakebin', 'claude'), path.join(__dirname, 'fixtures', 'fake-claude.c')])
  await waitFor('control', () => fs.existsSync(path.join(dir, 'control.json')), 10000)
  const { id } = JSON.parse(await cli('open', '--cwd', '/tmp', '--name', 'stopme', '--command', `export PATH="${WORK}/fakebin:$PATH" FAKE_CLAUDE_LOG=${LOG} FAKE_PROJECT_DIR=${PROJ}; claude --session-id ${SID}`))
  await waitFor('conversation', async () => (await js(`window.term.pty.agent(${JSON.stringify(id)})`))?.sessionId === SID, 15000)
  await waitFor('row has Stop', () => js(`!!document.querySelector('.rail .tab-stop:not(.is-stopped)')`), 10000)
  assert.equal(fakes().length, 1, 'fake claude running')

  await js(`document.querySelector('.rail .tab-stop').dispatchEvent(new MouseEvent('mousedown',{bubbles:true}))`)
  await waitFor('claude ended', () => fakes().length === 0, 8000)
  await waitFor('row shows Resume', () => js(`!!document.querySelector('.rail .tab-stop.is-stopped')`), 10000)
  // Opening it again does not restart it: only Resume does.
  await js(`window.term.window.wake(${JSON.stringify(id)})`); await delay(1500)
  assert.equal(fakes().length, 0, 'opening a stopped tab keeps it stopped')

  await js(`document.querySelector('.rail .tab-stop.is-stopped').dispatchEvent(new MouseEvent('mousedown',{bubbles:true}))`)
  await waitFor('resumed', () => fakes().length === 1, 15000)
  const last = starts().pop()
  assert.match(last, new RegExp(`--resume ${SID}`), last)
  await waitFor('row has Stop again', () => js(`!!document.querySelector('.rail .tab-stop:not(.is-stopped)')`), 10000)
  console.log('PASS stop: Stop ends claude and frees it, opening keeps it stopped, Resume brings the same conversation back')
  await cli('close', id).catch(() => {}); app.quit()
})().catch(e => { console.error(e); app.exit(1) }) }))
app.on('quit', () => { try { fs.rmSync(PROJ, { recursive: true, force: true }) } catch {}; for (const p of fakes()) { try { process.kill(Number(p)) } catch {} } })
setTimeout(() => { console.error('timeout'); app.exit(1) }, 90000).unref(); require('../out/main/index.js')
