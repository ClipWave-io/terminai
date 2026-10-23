// End-to-end: a tab stopped on a prompt reads as 'question' through the built
// app — the renderer detects it off the rendered screen, tells main, and both
// `terminai list` and the rail dot report it. Each tab prints a real screenshot
// of a prompt (tests/fixtures/questions) and then sleeps, so the terminal parks
// on the selected option exactly as a waiting agent does.
// After `npx electron-vite build`: CODEX_HOME=<scratch dir> TERMINAI_TEST_BUILD=1 npx electron tests/question-ui.cjs
const { app } = require('electron'), fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert/strict'), { execFile } = require('child_process')
if (!process.env.CODEX_HOME) { console.error('Set CODEX_HOME to a scratch folder.'); process.exit(1) }
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'terminai-question-')); app.setPath('userData', dir)
fs.writeFileSync(path.join(dir, 'prefs.json'), JSON.stringify({ seenWelcome: true, tabs: [], voice: { enabled: false }, railWidth: 300 }))
const delay = ms => new Promise(r => setTimeout(r, ms))
const fxDir = path.join(__dirname, 'fixtures/questions')
const cli = (...args) => new Promise(resolve => execFile(process.execPath, [path.join(__dirname, '..', 'resources/terminai.cjs'), ...args], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', TERMINAI_CONTROL: path.join(dir, 'control.json') } }, (e, out, err) => resolve({ ok: !e, out: String(out), err: String(err) })))

// A tab that prints the fixture then sleeps: the screen stays on the prompt. `exec`, so the
// foreground is not a bare shell, which statusOf rightly reads as "ready" before any prompt.
async function ask(name, fixture) {
  const r = await cli('open', '--cwd', dir, '--name', name, '--', 'sh', '-c', `cat "$1"; exec sleep 40`, '_', path.join(fxDir, fixture))
  assert.ok(r.ok, r.err)
  return JSON.parse(r.out).id
}
const statusOf = (list, id) => list.find(t => t.id === id)

app.on('browser-window-created', (_e, win) => win.webContents.once('did-finish-load', () => { void (async () => {
  await delay(1500)
  const ids = {
    trust: await ask('ask-trust', 'trust.txt'),
    permission: await ask('ask-perm', 'permission.txt'),
    plan: await ask('ask-plan', 'plan.txt'),
    question: await ask('ask-quest', 'askquestion.txt'),
  }
  // A control tab that is merely busy, never on a prompt.
  const busy = (await cli('open', '--cwd', dir, '--name', 'busy', '--command', 'sleep 40').then(r => JSON.parse(r.out).id))
  // Two poll cycles (800 ms each) so detection fires and reaches main.
  await delay(2600)

  const list = JSON.parse((await cli('list')).out)
  for (const [kind, id] of Object.entries(ids)) {
    const t = statusOf(list, id)
    assert.ok(t, `${kind} tab missing from list`)
    assert.equal(t.status, 'question', `${kind}: terminai list status is "${t.status}", not "question"`)
    assert.equal(t.question, kind, `${kind}: terminai list question is "${t.question}"`)
  }
  const b = statusOf(list, busy)
  assert.notEqual(b.status, 'question', `a busy tab must not read as a question (got "${b.status}")`)
  assert.equal(b.question, '', 'a busy tab carries no question kind')

  // The rail shows one accented "?" dot per waiting tab, and not for the busy one.
  win.setSize(900, 700); await delay(300)
  const dots = await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.rail .tab-dot.question')).map(d => d.textContent)`)
  assert.equal(dots.length, 4, `expected 4 question dots in the rail, got ${dots.length}`)
  assert.ok(dots.every(t => t === '?'), 'each question dot shows a "?"')
  const shot = path.join(os.tmpdir(), 'terminai-question-rail.png')
  fs.writeFileSync(shot, (await win.capturePage()).toPNG())

  // Hidden from the rail (Ilai's hide button, which acts on mousedown), a tab on a question still shows while it waits;
  // a busy tab hidden the same way goes.
  const hide = name => win.webContents.executeJavaScript(`(() => { const row = Array.from(document.querySelectorAll('.rail .tab')).find(r => r.querySelector('.tab-title')?.textContent === ${JSON.stringify(name)}); row?.querySelector('.tab-hide')?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); return !!row })()`)
  assert.ok(await hide('ask-quest'), 'ask-quest row present'); assert.ok(await hide('busy'), 'busy row present')
  await delay(1800)
  const titles = await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.rail .tab .tab-title')).map(e => e.textContent)`)
  assert.ok(titles.includes('ask-quest'), `a hidden tab on a question must stay in the rail (rows: ${titles})`)
  assert.ok(!titles.includes('busy'), `a hidden busy tab leaves the rail (rows: ${titles})`)
  console.log(`PASS question UI: 4 prompts read as "question" in terminai list and the rail (trust/permission/plan/question), a busy tab stays "${b.status}", hidden question tab stays in the rail, hidden busy tab leaves; screenshot ${shot}`)
  fs.rmSync(dir, { recursive: true, force: true }); app.quit()
})().catch(e => { console.error(e); fs.rmSync(dir, { recursive: true, force: true }); app.exit(1) }) }))
setTimeout(() => { console.error('question UI timeout'); app.exit(1) }, 90000).unref()
require(path.join(__dirname, '../out/main/index.js'))
