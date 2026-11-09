// Settings › Memory lists the sessions with their memory.
const { app } = require('electron'), fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert/strict')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'terminai-mem-')), dir = path.join(root, 'userData'); fs.mkdirSync(dir); app.setPath('userData', dir)
fs.writeFileSync(path.join(dir, 'prefs.json'), JSON.stringify({ seenWelcome: true, tabs: [], voice: { enabled: false }, tasksUser: 'ilai' }))
const delay = ms => new Promise(r => setTimeout(r, ms))
app.on('browser-window-created', (_e, win) => win.webContents.once('did-finish-load', () => { void (async () => {
  const js = c => win.webContents.executeJavaScript(c)
  try {
    await delay(2500); win.setSize(1300, 900)
    await js(`document.querySelector('[aria-label="Settings"]').click()`); await delay(800)
    const shot = n => win.webContents.capturePage(undefined, { stayHidden: true }).then(i => fs.writeFileSync(path.join(os.tmpdir(), `terminai-settings-${n}.png`), i.toPNG()))
    await shot('general')
    for (const n of ['Connections', 'Notifications']) { await js(`[...document.querySelectorAll('.team-side nav button')].find(b => b.textContent === '${n}').click()`); await delay(700); await shot(n.toLowerCase()) }
    await js(`[...document.querySelectorAll('.team-side nav button')].find(b => b.textContent === 'Memory').click()`); await delay(2500)
    const text = await js(`document.querySelector('.mem')?.innerText || ''`)
    assert.match(text, /Memory[\s\S]*TerminAI sessions[\s\S]*Other apps[\s\S]*Free/)
    fs.writeFileSync(path.join(os.tmpdir(), 'terminai-memory.png'), (await win.webContents.capturePage(undefined, { stayHidden: true })).toPNG())
    console.log('PASS memory panel: ' + text.split('\n').slice(0, 3).join(' | ')); app.exit(0)
  } catch (e) { console.error(e); app.exit(1) }
})() }))
require(path.join(__dirname, '../out/main/index.js'))
