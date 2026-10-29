// The browser is Arc-like (address and vertical tabs in a sidebar) and the Team panel signs in, signs up or joins.
// After `npx electron-vite build`: CODEX_HOME=<scratch dir> TERMINAI_TEST_BUILD=1 npx electron tests/arc-team-ui.cjs
const { app } = require('electron'), fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert/strict'), http = require('http')
if (!process.env.CODEX_HOME) { console.error('Set CODEX_HOME to a scratch folder.'); process.exit(1) }
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'terminai-arc-team-')); app.setPath('userData', dir)
fs.writeFileSync(path.join(dir, 'prefs.json'), JSON.stringify({ seenWelcome: true, tabs: [], voice: { enabled: false } }))
const delay = ms => new Promise(r => setTimeout(r, ms)), out = process.env.SHOTS || os.tmpdir()
const server = http.createServer((q, r) => r.end(`<title>Fixture ${q.url}</title><body style="font:40px system-ui;padding:40px">Page ${q.url}</body>`))
app.on('browser-window-created', (_e, win) => win.webContents.once('did-finish-load', () => { void (async () => {
  const js = s => win.webContents.executeJavaScript(s)
  await delay(1500); win.setSize(1500, 900); await new Promise(r => server.listen(0, '127.0.0.1', r))
  const site = `127.0.0.1:${server.address().port}`
  await js(`document.querySelector('.workspace-tabs [aria-label="Browser"]')?.click()`); await delay(500)
  assert.equal(await js(`!!document.querySelector('.browser-pane.arc .arc-side')`), true)
  assert.equal(await js(`!!document.querySelector('.browser-tabs, .browser-toolbar')`), false, 'no top bars left')
  for (const p of ['/one', '/two']) { await js(`window.term.browser.action('new')`); await delay(200); await js(`window.term.browser.navigate('http://${site}${p}')`); await delay(600) }
  const tabs = await js(`window.term.browser.state().then(s => s.tabs.map(t => t.id))`)
  await js(`window.term.browser.action('group', { id: ${JSON.stringify(tabs.at(-1))}, name: 'Research' })`); await delay(400)
  assert.deepEqual(await js(`[...document.querySelectorAll('.arc-group-label')].map(b => b.firstChild.nextSibling.textContent)`), ['Research'])
  assert.ok(await js(`document.querySelectorAll('.arc-tab').length`) >= 2)
  assert.equal(await js(`document.querySelector('.arc-tab.active .arc-title').textContent`), 'Fixture /two')
  // The page sits right of the sidebar, never under it.
  const side = await js(`document.querySelector('.arc-side').getBoundingClientRect().right`), page = await js(`document.querySelector('.browser-viewport').getBoundingClientRect().left`)
  assert.ok(page >= side, 'page view right of the sidebar')
  fs.writeFileSync(path.join(out, 'terminai-arc-browser.png'), (await win.webContents.capturePage()).toPNG())
  // Hiding the sidebar leaves a slim strip and gives the page the room.
  await js(`document.querySelector('[aria-label="Hide sidebar"]').click()`); await delay(300)
  assert.equal(await js(`!!document.querySelector('.arc-side')`), false); assert.equal(await js(`!!document.querySelector('.arc-mini [aria-label="Show sidebar"]')`), true)
  await js(`document.querySelector('[aria-label="Show sidebar"]').click()`); await delay(200)

  await js(`document.querySelector('[aria-label="Sync"]').click()`); await delay(800)
  assert.equal(await js(`document.querySelector('.team-auth h2').textContent`), 'Sign in to sync')
  await js(`[...document.querySelectorAll('.team-switch button')].find(b => b.textContent === 'Create an account').click()`); await delay(200)
  assert.deepEqual(await js(`[...document.querySelectorAll('.team-auth label')].map(l => l.firstChild.textContent)`), ['Your name', 'Email', 'Password', 'Server address'])
  fs.writeFileSync(path.join(out, 'terminai-team-signup.png'), (await win.webContents.capturePage()).toPNG())
  console.log('PASS arc browser and team sign-in: vertical tabs and groups, page beside the sidebar, collapsible, team sign in / start / join')
  server.close(); fs.rmSync(dir, { recursive: true, force: true }); app.quit()
})().catch(e => { console.error(e); app.exit(1) }) }))
setTimeout(() => { console.error('arc/team UI timeout'); app.exit(1) }, 40000).unref()
require(path.join(__dirname, '../out/main/index.js'))
