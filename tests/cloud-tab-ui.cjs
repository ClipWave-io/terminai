// A tab that starts a cloud session (claude --cloud prints "Created cloud session" and "View: <url>") gets a ☁ in the
// sidebar and keeps the session's link. The output is played back with printf: no real cloud session is made.
const { app } = require('electron'), fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert/strict')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'terminai-cloud-')); app.setPath('userData', dir)
fs.writeFileSync(path.join(dir, 'prefs.json'), JSON.stringify({ seenWelcome: true, tabs: [], voice: { enabled: false }, newTabAgent: 'none' }))
const delay = ms => new Promise(r => setTimeout(r, ms))
app.on('browser-window-created', (_e, win) => win.webContents.once('did-finish-load', () => { void (async () => {
  await delay(1500); const js = s => win.webContents.executeJavaScript(s)
  const id = await js(`window.term.pty.list().then(t=>t[0].id)`)
  await js(`window.term.pty.write(${JSON.stringify(id)}, "printf 'Created cloud session: Fix the login page\\\\nView: https://claude.ai/code/session_01ABCdef234?from=cli&m=0\\\\nResume with: claude --teleport session_01ABCdef234\\\\n'\\r")`)
  for (let i = 0; i < 40 && !await js(`!!document.querySelector('.rail .tab-cloud')`); i++) await delay(250)
  assert.ok(await js(`!!document.querySelector('.rail .tab-cloud')`), 'cloud mark in the sidebar')
  assert.match(await js(`document.querySelector('.rail .tab-cloud').title`), /Fix the login page/)
  await delay(1500)
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'prefs.json'), 'utf8')).tabs[0].cloud
  assert.equal(saved?.id, 'session_01ABCdef234', 'kept with the tab')
  console.log('PASS cloud tab: ☁ in the sidebar with the session title, link kept across restarts'); app.quit()
})().catch(e => { console.error(e); app.exit(1) }) }))
setTimeout(() => app.exit(1), 40000).unref(); require('../out/main/index.js')
