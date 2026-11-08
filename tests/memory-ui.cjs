// Settings › Memory lists the sessions with their memory.
const { app } = require('electron'), fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert/strict')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'terminai-mem-')), dir = path.join(root, 'userData'); fs.mkdirSync(dir); app.setPath('userData', dir)
fs.writeFileSync(path.join(dir, 'prefs.json'), JSON.stringify({ seenWelcome: true, tabs: [], voice: { enabled: false }, tasksUser: 'ilai' }))
const delay = ms => new Promise(r => setTimeout(r, ms))
app.on('browser-window-created', (_e, win) => win.webContents.once('did-finish-load', () => { void (async () => {
  const js = c => win.webContents.executeJavaScript(c)
  try {
    await delay(2500); win.setSize(1300, 900)
    await js(`document.querySelector('[aria-label="Settings"]').click()`); await delay(2500)
    const text = await js(`document.querySelector('.mem')?.innerText || ''`)
    assert.match(text, /Memory[\s\S]*Sessions[\s\S]*TerminAI itself/)
    fs.writeFileSync(path.join(os.tmpdir(), 'terminai-memory.png'), (await win.webContents.capturePage(undefined, { stayHidden: true })).toPNG())
    console.log('PASS memory panel: ' + text.split('\n').slice(0, 3).join(' | ')); app.exit(0)
  } catch (e) { console.error(e); app.exit(1) }
})() }))
require(path.join(__dirname, '../out/main/index.js'))
