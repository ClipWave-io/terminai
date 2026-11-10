// The To-do window's Log tab, from real-looking transcripts in a scratch HOME-less layout: today's conversations, hours and finished work.
// After `npx electron-vite build`: CODEX_HOME=<scratch dir> TERMINAI_TEST_BUILD=1 npx electron tests/worklog-ui.cjs
const electron = require('electron'), { app } = electron, fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert/strict')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'terminai-worklog-')), dir = path.join(root, 'userData'); fs.mkdirSync(dir); app.setPath('userData', dir)
fs.writeFileSync(path.join(dir, 'prefs.json'), JSON.stringify({ seenWelcome: true, tabs: [], voice: { enabled: false }, tasksUser: 'ilai' }))
const delay = ms => new Promise(r => setTimeout(r, ms))
app.on('browser-window-created', (_e, win) => win.webContents.once('did-finish-load', () => { void (async () => {
  const js = code => win.webContents.executeJavaScript(code)
  try {
    await delay(1200); win.setSize(1400, 860); await delay(300)
    await js(`document.querySelector('.todo-button').click()`); await delay(500)
    await js(`[...document.querySelectorAll('.todo-seg button')].find(b => b.textContent === 'Log').click()`)
    // Today's transcripts can take a while on a busy Mac: wait for the log, not a fixed time.
    let text = ''; for (let i = 0; i < 80 && !/working time|No conversations this day/.test(text); i++) { await delay(250); text = await js(`document.querySelector('.wlog')?.innerText || ''`) }
    assert.match(text, /working time|No conversations this day/)
    fs.writeFileSync(path.join(os.tmpdir(), 'terminai-worklog.png'), (await win.webContents.capturePage(undefined, { stayHidden: true })).toPNG())
    console.log(`PASS work log tab: ${text.split('\n').slice(0, 3).join(' | ')} · ${path.join(os.tmpdir(), 'terminai-worklog.png')}`)
    app.exit(0)
  } catch (e) { console.error(e); app.exit(1) }
})() }))
require(path.join(__dirname, '../out/main/index.js'))
