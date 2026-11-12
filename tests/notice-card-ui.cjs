// A sound never comes alone: every new notice shows as a card at the top right, saying what it is.
const { app } = require('electron'), fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert/strict')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'terminai-card-')); app.setPath('userData', dir)
fs.writeFileSync(path.join(dir, 'prefs.json'), JSON.stringify({ seenWelcome: true, tabs: [], voice: { enabled: false }, newTabAgent: 'none', sounds: { chat: false, call: false, done: false, request: false, agent: false, todo: false, memory: false, update: false } }))
const delay = ms => new Promise(r => setTimeout(r, ms))
app.on('browser-window-created', (_e, win) => win.webContents.once('did-finish-load', () => { void (async () => {
  await delay(1500); const js = s => win.webContents.executeJavaScript(s)
  await js(`window.term.teamchat.notify('Matteo Livio', 'Did you see the deck?')`); await delay(500)
  assert.match(await js(`document.querySelector('.notice-card')?.textContent||''`), /Matteo Livio.*Did you see the deck/, 'card shows who and what')
  await js(`document.querySelector('.notice-card-x').click()`); await delay(200)
  assert.ok(await js(`!document.querySelector('.notice-card')`), 'dismissed')
  console.log('PASS notice card: a new notice shows who and what, and can be dismissed'); app.quit()
})().catch(e => { console.error(e); app.exit(1) }) }))
setTimeout(() => app.exit(1), 30000).unref(); require('../out/main/index.js')
