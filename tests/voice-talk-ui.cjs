// The Talk button beside Shared, end to end with the real models: a recorded sentence plays as the microphone, Parakeet
// writes it into a (fake) claude tab with Enter, the answer appended to its transcript is read aloud by Kokoro, then it
// listens again; an answer with VOICE: off ends the conversation.
// Needs ~/.clipwave-term/tts with parakeet-mlx (the first Talk sets it up). After `npx electron-vite build`:
// TERMINAI_TEST_BUILD=1 npx electron tests/voice-talk-ui.cjs
const { app } = require('electron'), fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto'), assert = require('assert/strict'), { execFileSync, execFile } = require('child_process')
const REAL = os.homedir(), REPO = path.join(__dirname, '..')
// The fake conversation's transcript goes where Claude Code keeps them, in a folder of its own removed at the end.
const PROJ = path.join(REAL, '.claude', 'projects', `-terminai-voice-test-${process.pid}`); fs.mkdirSync(PROJ, { recursive: true })
const step = s => console.log(new Date().toISOString().slice(11, 19), s)
step('start')

// The microphone: a spoken question, then silence long enough to end it (Chromium loops the file).
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'terminai-voice-'))
execFileSync('/usr/bin/say', ['-o', path.join(WORK, 'q.aiff'), 'Give me a quick overview of what you did here.'])
execFileSync('/usr/bin/afconvert', ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', path.join(WORK, 'q.aiff'), path.join(WORK, 'q.wav')])
{ const w = fs.readFileSync(path.join(WORK, 'q.wav')), i = w.indexOf('data'), pcm = w.subarray(i + 8, i + 8 + w.readUInt32LE(i + 4))
  const all = Buffer.concat([Buffer.alloc(16000), pcm, Buffer.alloc(16000 * 2 * 3)]), h = Buffer.alloc(44)
  h.write('RIFF', 0); h.writeUInt32LE(36 + all.length, 4); h.write('WAVEfmt ', 8); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22)
  h.writeUInt32LE(16000, 24); h.writeUInt32LE(32000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(all.length, 40)
  fs.writeFileSync(path.join(WORK, 'mic.wav'), Buffer.concat([h, all])) }
app.commandLine.appendSwitch('use-fake-device-for-media-stream')
app.commandLine.appendSwitch('use-fake-ui-for-media-stream')
app.commandLine.appendSwitch('disable-features', 'AudioServiceSandbox,AudioServiceOutOfProcess')
app.commandLine.appendSwitch('use-file-for-fake-audio-capture', path.join(WORK, 'mic.wav'))

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'terminai-voice-data-')); app.setPath('userData', dir)
fs.writeFileSync(path.join(dir, 'prefs.json'), JSON.stringify({ seenWelcome: true, tabs: [], voice: { enabled: false, volume: 0 }, newTabAgent: 'none' }))
const delay = ms => new Promise(r => setTimeout(r, ms))
const waitFor = async (what, fn, ms) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return; await delay(200) } throw new Error('timed out: ' + what) }
const LOG = path.join(WORK, 'fake.log'), SID = crypto.randomUUID(), T = path.join(PROJ, `${SID}.jsonl`)
const inputs = () => { try { return fs.readFileSync(LOG, 'utf8').split('\n').filter(l => l.startsWith('input ')) } catch { return [] } }
const answer = text => fs.appendFileSync(T, JSON.stringify({ type: 'assistant', message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text }] } }) + '\n' + JSON.stringify({ type: 'system', subtype: 'turn_duration' }) + '\n')
const cli = (...args) => new Promise((resolve, reject) => execFile(process.execPath, [path.join(REPO, 'resources/terminai.cjs'), ...args], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', TERMINAI_CONTROL: path.join(dir, 'control.json') } }, (e, out, err) => e ? reject(new Error(err || e.message)) : resolve(String(out))))

app.on('browser-window-created', (_e, win) => win.webContents.once('did-finish-load', () => { void (async () => {
  const js = s => win.webContents.executeJavaScript(s)
  const phase = () => js(`document.querySelector('.voice-btn')?.className.replace('corner-privacy voice-btn ','') || ''`)
  fs.mkdirSync(path.join(WORK, 'fakebin'))
  execFileSync('clang', ['-O1', '-o', path.join(WORK, 'fakebin', 'claude'), path.join(__dirname, 'fixtures', 'fake-claude.c')])
  await waitFor('control', () => fs.existsSync(path.join(dir, 'control.json')), 10000)
  const { id } = JSON.parse(await cli('open', '--cwd', '/tmp', '--name', 'voice', '--command', `export PATH="${WORK}/fakebin:$PATH" FAKE_CLAUDE_LOG=${LOG} FAKE_PROJECT_DIR=${PROJ}; claude --session-id ${SID}`))
  step('tab open'); await cli('focus', id)
  await waitFor('conversation', async () => (await js(`window.term.pty.agent(${JSON.stringify(id)})`))?.sessionId === SID, 15000)
  await waitFor('Talk button', async () => /Talk/.test(await js(`document.querySelector('.voice-btn')?.textContent || ''`)), 10000)

  step('button shown'); await js(`document.querySelector('.voice-btn').click()`)
  await waitFor('what was said reaches claude', () => inputs().length >= 1, 90000)
  const said = inputs()[0]; step(said)
  assert.match(said, /overview of what you did here/i, said)
  assert.match(said, /said by voice in TerminAI/, 'with the note for the agent')
  assert.equal(await phase(), 'working')

  answer('Here is the overview: I added a **voice** button next to Shared, see `src/renderer/App.tsx`.\n\nSPOKEN: I added a voice button.')
  await waitFor('reads the answer aloud', async () => (await phase()) === 'speaking', 30000)
  await waitFor('then listens again', async () => ['listening', 'hearing'].includes(await phase()), 30000)
  await waitFor('second question', () => inputs().length >= 2, 60000)
  answer('This needs a full rebuild, about ten minutes. I will start now.\nVOICE: off')
  await waitFor('the agent ends the conversation', async () => (await phase()) === 'off', 30000)
  assert.match(await js(`document.querySelector('.voice-note')?.textContent || ''`), /Voice off/)
  await delay(800)
  assert.equal(inputs().length, 2, 'nothing more is sent once it is off')
  console.log('PASS voice talk: speech goes in with Enter, the answer is read aloud, it listens again, VOICE: off ends it')
  await cli('close', id).catch(() => {}); app.quit()
})().catch(e => { console.error(e); app.exit(1) }) }))
app.on('quit', () => { try { fs.rmSync(PROJ, { recursive: true, force: true }) } catch {} })
setTimeout(() => { console.error('timeout'); app.exit(1) }, 240000).unref(); require('../out/main/index.js')
