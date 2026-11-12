// Right-click › Pause on a chat: everything running in the tab stops (state T), the row shows paused with a Resume
// banner, and Resume lets it run again. After `npx electron-vite build`: TERMINAI_TEST_BUILD=1 npx electron tests/pause-tab-ui.cjs
const { app } = require('electron'), fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert/strict'), { execFileSync } = require('child_process')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'terminai-pause-')); app.setPath('userData', dir)
fs.writeFileSync(path.join(dir, 'prefs.json'), JSON.stringify({ seenWelcome: true, tabs: [], voice: { enabled: false }, newTabAgent: 'none' }))
const delay = ms => new Promise(r => setTimeout(r, ms))
const state = pid => { try { return execFileSync('/bin/ps', ['-o', 'stat=', '-p', String(pid)]).toString().trim() } catch { return '' } }
app.on('browser-window-created', (_e, win) => win.webContents.once('did-finish-load', () => { void (async () => {
  await delay(1500); const js = s => win.webContents.executeJavaScript(s)
  const id = await js(`window.term.pty.list().then(t=>t[0].id)`)
  await js(`window.term.pty.write(${JSON.stringify(id)}, 'sleep 120\\r')`); await delay(1200)
  const pid = Number(execFileSync('/usr/bin/pgrep', ['-f', '^sleep 120$']).toString().trim().split('\n').pop())
  assert.ok(pid > 0, 'sleep running')
  await js(`window.term.pty.pause(${JSON.stringify(id)}, true)`); await delay(300)
  assert.match(state(pid), /^T/, 'stopped')
  assert.ok(await js(`!!document.querySelector('.rail .tab-dot.paused')&&/Paused by you/.test(document.querySelector('.guard-banner')?.textContent||'')`), 'paused dot and banner')
  await js(`document.querySelector('.guard-banner .btn.primary').click()`); await delay(500)
  assert.match(state(pid), /^S/, 'running again')
  assert.ok(await js(`!document.querySelector('.rail .tab-dot.paused')`), 'dot back to normal')
  try { process.kill(pid) } catch {}
  console.log('PASS pause: the chat stops, shows paused with Resume, and runs again'); app.quit()
})().catch(e => { console.error(e); app.exit(1) }) }))
setTimeout(() => app.exit(1), 40000).unref(); require('../out/main/index.js')
