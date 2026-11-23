// `terminai ask`: a side conversation asks the conversation it was opened beside. The question is typed in there,
// the answer is read from its transcript when the turn ends, and typed back into the side conversation. Two fake claudes.
// After `npx electron-vite build`: TERMINAI_TEST_BUILD=1 npx electron tests/side-ask-ui.cjs
process.env.TERMINAI_TEST_ALLOW_AGENTS = '1'
const { app } = require('electron'), fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto'), assert = require('assert/strict'), { execFileSync, execFile } = require('child_process')
const REPO = path.join(__dirname, '..')
const PROJ = path.join(os.homedir(), '.claude', 'projects', `-terminai-sideask-test-${process.pid}`); fs.mkdirSync(PROJ, { recursive: true })
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'terminai-sideask-'))
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'terminai-sideask-data-')); app.setPath('userData', dir)
fs.writeFileSync(path.join(dir, 'prefs.json'), JSON.stringify({ seenWelcome: true, tabs: [], voice: { enabled: false }, newTabAgent: 'none' }))
const delay = ms => new Promise(r => setTimeout(r, ms))
const waitFor = async (what, fn, ms) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return; await delay(250) } throw new Error('timed out: ' + what) }
const A = crypto.randomUUID(), B = crypto.randomUUID(), logOf = s => path.join(WORK, s + '.log')
const inputs = s => { try { return fs.readFileSync(logOf(s), 'utf8').split('\n').filter(l => l.startsWith('input ')) } catch { return [] } }
const cli = (env, ...args) => new Promise((resolve, reject) => execFile(process.execPath, [path.join(REPO, 'resources/terminai.cjs'), ...args], { env: { ...process.env, ...env, ELECTRON_RUN_AS_NODE: '1', TERMINAI_CONTROL: path.join(dir, 'control.json') } }, (e, out, err) => e ? reject(new Error(err || e.message)) : resolve(String(out))))
const answer = (sid, text) => fs.appendFileSync(path.join(PROJ, `${sid}.jsonl`), JSON.stringify({ type: 'assistant', message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text }] } }) + '\n' + JSON.stringify({ type: 'system', subtype: 'turn_duration' }) + '\n')

app.on('browser-window-created', (_e, win) => win.webContents.once('did-finish-load', () => { void (async () => {
  const js = s => win.webContents.executeJavaScript(s)
  fs.mkdirSync(path.join(WORK, 'fakebin'))
  execFileSync('clang', ['-O1', '-o', path.join(WORK, 'fakebin', 'claude'), path.join(__dirname, 'fixtures', 'fake-claude.c')])
  await waitFor('control', () => fs.existsSync(path.join(dir, 'control.json')), 10000)
  const open = async (name, sid) => JSON.parse(await cli({}, 'open', '--cwd', '/tmp', '--name', name, '--command', `export PATH="${WORK}/fakebin:$PATH" FAKE_CLAUDE_LOG=${logOf(sid)} FAKE_PROJECT_DIR=${PROJ}; claude --session-id ${sid}`)).id
  const orig = await open('original', A), side = await open('side', B)
  for (const [id, sid] of [[orig, A], [side, B]]) await waitFor('conversation ' + sid, async () => (await js(`window.term.pty.agent(${JSON.stringify(id)})`))?.sessionId === sid, 15000)

  const r = JSON.parse(await cli({ TERMINAI_TAB_ID: side }, 'ask', orig, 'Which', 'colour', 'did', 'we', 'pick?'))
  assert.equal(r.queued, true)
  await waitFor('question typed into the original', () => inputs(A).length >= 1, 30000)
  assert.match(inputs(A)[0], /question from the side conversation "side".*Which colour did we pick\?/, inputs(A)[0])
  answer(A, 'We picked teal.\n\nSPOKEN: Teal.')
  await waitFor('answer typed back into the side conversation', () => inputs(B).length >= 1, 40000)
  assert.match(inputs(B)[0], /answer from the conversation "original".*We picked teal\./, inputs(B)[0])
  assert.doesNotMatch(inputs(B)[0], /SPOKEN/)
  await assert.rejects(cli({ TERMINAI_TAB_ID: side }, 'ask', side, 'hi'), /this conversation/)
  console.log('PASS side ask: the question reaches the original when free, its answer comes back into the side conversation')
  await cli({}, 'close', orig).catch(() => {}); await cli({}, 'close', side).catch(() => {}); app.quit()
})().catch(e => { console.error(e); app.exit(1) }) }))
app.on('quit', () => { try { fs.rmSync(PROJ, { recursive: true, force: true }) } catch {}; try { execFileSync('/usr/bin/pkill', ['-f', `^claude --session-id (${A}|${B})`]) } catch {} })
setTimeout(() => { console.error('timeout'); app.exit(1) }, 120000).unref(); require('../out/main/index.js')
