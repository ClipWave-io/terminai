// Share with…: a shared tab shows "shared with <first name>" in the sidebar and keeps its share in prefs; right-click ›
// Share with… opens the picker (people by organisation), picking someone shares it, Stop sharing takes it back, and
// Invite someone new… makes an invite link. The workspace server is faked here (the IPC handlers are replaced).
// Screenshots: $TMPDIR/terminai-share-*.png. After `npx electron-vite build`: TERMINAI_TEST_BUILD=1 npx electron tests/share-with-ui.cjs
const { app, ipcMain } = require('electron'), fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert/strict')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'terminai-share-')); app.setPath('userData', dir)
const f = path.join(dir, 'proj'); fs.mkdirSync(f)
const tab = (title, share) => ({ cwd: f, title, customTitle: title, share, notes: '', focusedMs: 0 })
fs.writeFileSync(path.join(dir, 'prefs.json'), JSON.stringify({ seenWelcome: true, groupByFolder: true, voice: { enabled: false }, newTabAgent: 'none', railWidth: 300,
  tabs: [tab('Landing page copy', { company: 'c-beta', companyName: 'Beta Studio', people: [{ id: 'u-lena', name: 'Lena Novak' }] }), tab('Release notes')] }))
const delay = ms => new Promise(r => setTimeout(r, ms))
const out = n => path.join(os.tmpdir(), `terminai-share-${n}.png`)
const orgs = [{ id: 'c-alpha', name: 'ClipWave', role: 'owner' }, { id: 'c-beta', name: 'Beta Studio', role: 'member' }]
const members = { 'c-alpha': [{ id: 'u-me', name: 'Ilai Bachrach', email: 'me@example.test' }, { id: 'u-matteo', name: 'Matteo Rossi', email: 'matteo@example.test' }, { id: 'u-fritz', name: 'Fritz Weber', email: 'fritz@example.test' }],
  'c-beta': [{ id: 'u-me', name: 'Ilai Bachrach', email: 'me@example.test' }, { id: 'u-lena', name: 'Lena Novak', email: 'lena@beta.test' }] }
app.on('browser-window-created', (_e, win) => win.webContents.once('did-finish-load', () => { void (async () => {
  const js = s => win.webContents.executeJavaScript(s)
  const shot = async n => fs.writeFileSync(out(n), (await win.webContents.capturePage(undefined, { stayHidden: true })).toPNG())
  const saved = () => JSON.parse(fs.readFileSync(path.join(dir, 'prefs.json'), 'utf8')).tabs.map(t => t.share ? `${t.share.company}:${t.share.people.map(p => p.id).join(',')}` : '')
  win.setSize(1200, 800)
  for (const ch of ['workspace:state', 'workspace:request', 'tab:menu']) ipcMain.removeHandler(ch)
  ipcMain.handle('workspace:state', () => ({ url: 'https://x.test', signedIn: true, identity: { user: { id: 'u-me', email: 'me@example.test', name: 'Ilai Bachrach' }, companies: orgs } }))
  ipcMain.handle('workspace:request', (_e, p, method) => {
    const m = /^\/api\/companies\/([^/]+)\/(members|invites\/link)$/.exec(p)
    if (m && m[2] === 'members') return { members: members[m[1]] ?? [] }
    if (m && method === 'POST') return { inviteUrl: 'https://terminai.test/#invite=abc123', expiresInHours: 24 }
    throw Error('unexpected ' + p)
  })
  ipcMain.handle('tab:menu', () => 'share')
  for (let i = 0; i < 60 && (await js(`document.querySelectorAll('.rail .tab').length`)) < 2; i++) await delay(150)
  const row = t => `[...document.querySelectorAll('.rail .tab')].find(r => r.textContent.includes(${JSON.stringify(t)}))`
  assert.match(await js(`${row('Landing page copy')}.querySelector('.tab-share')?.textContent || ''`), /shared with Lena/)
  assert.equal(await js(`!!${row('Release notes')}.querySelector('.tab-share')`), false)
  await shot('rail')
  // Right-click › Share with… on the unshared tab: the picker, people grouped by organisation, without me.
  await js(`${row('Release notes')}.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }))`)
  for (let i = 0; i < 40 && !(await js(`document.querySelectorAll('.share-person:not(.invite)').length`)); i++) await delay(100)
  const text = await js(`document.querySelector('.share-sheet').innerText`)
  assert.match(text, /ClipWave[\s\S]*Matteo Rossi[\s\S]*Fritz Weber[\s\S]*Beta Studio[\s\S]*Lena Novak/i); assert.doesNotMatch(text, /Ilai Bachrach/)
  await shot('picker')
  await js(`[...document.querySelectorAll('.share-person')].find(b => b.textContent.includes('Fritz')).click()`); await delay(300)
  assert.match(await js(`document.querySelector('.share-now')?.innerText || ''`), /Shared with Fritz Weber in ClipWave/)
  await shot('picked')
  // Invite someone new…: an organisation, then a link.
  await js(`[...document.querySelectorAll('.share-person.invite')][0].click()`); await delay(200)
  await js(`[...document.querySelectorAll('.share-invite .btn')].find(b => b.textContent.includes('Make invite link')).click()`); await delay(300)
  assert.match(await js(`document.querySelector('.share-link code')?.textContent || ''`), /invite=abc123/)
  await shot('invite')
  await js(`[...document.querySelectorAll('.share-sheet .btn')].find(b => b.textContent === 'Done').click()`); await delay(1500)
  assert.match(await js(`${row('Release notes')}.querySelector('.tab-share')?.textContent || ''`), /shared with Fritz/)
  assert.deepEqual(saved(), ['c-beta:u-lena', 'c-alpha:u-fritz'], 'shares saved with the tabs')
  // Stop sharing on the first one.
  await js(`${row('Landing page copy')}.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }))`); await delay(500)
  await shot('shared-sheet')
  await js(`[...document.querySelectorAll('.share-now .btn')].find(b => b.textContent === 'Stop sharing').click()`); await delay(200)
  await js(`[...document.querySelectorAll('.share-sheet .btn')].find(b => b.textContent === 'Done').click()`); await delay(1500)
  assert.equal(await js(`!!${row('Landing page copy')}.querySelector('.tab-share')`), false)
  assert.deepEqual(saved(), ['', 'c-alpha:u-fritz'])
  await shot('after')
  console.log('PASS share with: mark in the sidebar, picker by organisation, share and stop sharing saved, invite link')
  app.exit(0)
})().catch(e => { console.error(e); app.exit(1) }) }))
setTimeout(() => { console.error('timeout'); app.exit(1) }, 60000).unref(); require('../out/main/index.js')
