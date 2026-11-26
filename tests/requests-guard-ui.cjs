// A requests session (one per teammate, src/main/index.ts requestsTab) reaches Shared tabs only: terminai list, read, send,
// ask, focus and close from it refuse an Only me or Off the record tab, in code. Another tab is not limited. Plain shells, hidden.
// After `npx electron-vite build`: TERMINAI_TEST_BUILD=1 npx electron tests/requests-guard-ui.cjs
const { app, ipcMain } = require('electron'), fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert/strict'), { execFile } = require('child_process')
const REPO = path.join(__dirname, '..')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'terminai-reqguard-')); app.setPath('userData', dir)
const tab = (title, browserKey) => ({ cwd: dir, title, customTitle: title, browserKey, notes: '', focusedMs: 0 })
fs.writeFileSync(path.join(dir, 'prefs.json'), JSON.stringify({ seenWelcome: true, voice: { enabled: false }, newTabAgent: 'none', agentMessagesV: 2, agentMessages: 'requests',
  tabs: [tab('requests', 'key-req'), tab('shared', 'key-shared'), tab('mine', 'key-mine'), tab('off', 'key-off')],
  requestKeys: ['key-req'], tabModes: { 'key-req': 'shared', 'key-shared': 'shared', 'key-mine': 'private', 'key-off': 'off' } }))
const SHOT = process.env.SHOT || path.join(dir, 'requests-setting.png')
const handlers = new Map(), original = ipcMain.handle.bind(ipcMain); ipcMain.handle = (name, fn) => { handlers.set(name, fn); original(name, fn) }
const mock = (name, fn) => { ipcMain.removeHandler(name); original(name, fn) }
const delay = ms => new Promise(r => setTimeout(r, ms))
const cli = (env, ...args) => new Promise((resolve, reject) => execFile(process.execPath, [path.join(REPO, 'resources/terminai.cjs'), ...args], { env: { ...process.env, ...env, ELECTRON_RUN_AS_NODE: '1', TERMINAI_CONTROL: path.join(dir, 'control.json') } }, (e, out, err) => e ? reject(new Error(err || e.message)) : resolve(JSON.parse(String(out)))))
app.on('browser-window-created', (_e, win) => win.webContents.once('did-finish-load', () => { void (async () => {
  for (let i = 0; i < 80 && !fs.existsSync(path.join(dir, 'control.json')); i++) await delay(150)
  let all = []; for (let i = 0; i < 80 && all.length < 4; i++) { all = await cli({}, 'list').catch(() => []); await delay(150) }
  const id = n => all.find(t => t.name === n).id, req = { TERMINAI_TAB_ID: id('requests') }
  // Another tab sees and reaches every tab.
  assert.equal(all.length, 4)
  assert.equal((await cli({ TERMINAI_TAB_ID: id('shared') }, 'read', id('mine'))).id, id('mine'))
  // The requests session lists only Shared tabs (not itself), and reads or messages only those.
  assert.deepEqual((await cli(req, 'list')).map(t => t.name), ['shared'])
  assert.equal((await cli(req, 'read', id('shared'))).id, id('shared'))
  for (const target of ['mine', 'off']) for (const args of [['read', id(target)], ['send', id(target), 'hi'], ['ask', id(target), 'what?'], ['focus', id(target)], ['close', id(target)]])
    await assert.rejects(cli(req, ...args), /only reach conversations marked Shared/, `${args[0]} ${target}`)
  assert.equal((await cli({}, 'list')).length, 4, 'nothing was closed')
  // Sync › Conversations: "Requests session" is the default, with the folder it starts in (a fake sign-in, nothing leaves the Mac).
  const identity = { user: { id: 'me', name: 'Test user', email: 'test@example.invalid' }, companies: [{ id: 'one', name: 'First', role: 'owner', classification: 'developer', allowCompanySharing: true, defaultVisibility: 'company' }] }
  mock('workspace:state', () => ({ url: 'https://manager.test', signedIn: true, identity }))
  mock('workspace:request', () => ({ conversations: [], members: [] }))
  mock('workspace:setup-tools', () => [])
  const js = c => win.webContents.executeJavaScript(c)
  win.setSize(1300, 900); await delay(300)
  await js(`Array.from(document.querySelectorAll('.topbar button')).find(b=>b.getAttribute('aria-label')==='Sync').click()`); await delay(600)
  await js(`Array.from(document.querySelectorAll('.team-side nav button')).find(b=>/Conversations/.test(b.textContent)).click()`); await delay(800)
  assert.equal(await js(`Array.from(document.querySelectorAll('.sh-seg button.on')).map(b=>b.textContent).includes('Requests session')`), true)
  assert.match(await js(`document.querySelector('.sh').textContent`), /Requests sessions start in.*Your home folder/)
  await js(`Array.from(document.querySelectorAll('.sh-row strong')).find(e=>/Messages from others/.test(e.textContent)).scrollIntoView({block:'start'})`); await delay(300)
  fs.writeFileSync(SHOT, (await win.capturePage()).toPNG())
  console.log('PASS requests guard: a requests session reaches Shared tabs only (list, read, send, ask, focus, close)')
  app.quit()
})().catch(e => { console.error(e); app.exit(1) }) }))
setTimeout(() => { console.error('timeout'); app.exit(1) }, 60000).unref(); require('../out/main/index.js')
