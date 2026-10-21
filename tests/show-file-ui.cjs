// `terminai show <file>`: a session opens a file in the Files pane beside the tabs, not in another app.
// After `npx electron-vite build`: CODEX_HOME=<scratch dir> TERMINAI_TEST_BUILD=1 npx electron tests/show-file-ui.cjs
const { app } = require('electron'), fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert/strict'), { execFile } = require('child_process')
if (!process.env.CODEX_HOME) { console.error('Set CODEX_HOME to a scratch folder: the app writes its Codex config there.'); process.exit(1) }
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'terminai-show-')); app.setPath('userData', dir)
fs.writeFileSync(path.join(dir, 'prefs.json'), JSON.stringify({ seenWelcome: true, tabs: [], voice: { enabled: false } }))
const docs = path.join(dir, 'docs folder'); fs.mkdirSync(docs)
fs.copyFileSync(path.join(__dirname, 'fixtures', 'two-pages.pdf'), path.join(docs, 'two pages.pdf'))
fs.writeFileSync(path.join(docs, 'notes.md'), '# Notes\n\nOpened by a session.\n')
const delay = ms => new Promise(r => setTimeout(r, ms))
// Never execFileSync here: the control server answers from this very process.
const cli = (...args) => new Promise(resolve => execFile(process.execPath, [path.join(__dirname, '..', 'resources/terminai.cjs'), ...args], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', TERMINAI_CONTROL: path.join(dir, 'control.json') } }, (e, out, err) => resolve({ ok: !e, out: String(out), err: String(err) })))
app.on('browser-window-created', (_e, win) => win.webContents.once('did-finish-load', () => { void (async () => {
  const js = code => win.webContents.executeJavaScript(code)
  await delay(1500); win.setSize(1400, 860); await delay(300)
  assert.equal(await js(`!!document.querySelector('.files-slot')`), false, 'no Files pane before')
  let r = await cli('show', path.join(docs, 'two pages.pdf'))
  assert.ok(r.ok, r.err)
  await delay(2500)
  assert.equal(await js(`!!document.querySelector('.files-slot:not(.workspace-hidden)')`), true, 'the Files pane opens')
  assert.match(await js(`document.querySelector('.file-preview-title')?.textContent || ''`), /two pages\.pdf/)
  assert.equal(await js(`document.querySelector('.files-status')?.textContent`), 'PDF viewer')
  assert.equal(await js(`document.querySelectorAll('.term-host').length > 0`), true, 'the terminal stays beside it')
  fs.writeFileSync(path.join(os.tmpdir(), 'terminai-show-pdf.png'), (await win.webContents.capturePage(undefined, { stayHidden: true })).toPNG())
  r = await cli('show', path.join(docs, 'notes.md')); assert.ok(r.ok, r.err); await delay(1500)
  assert.match(await js(`document.querySelector('.file-preview-title')?.textContent || ''`), /notes\.md/)
  // Any kind of file, made here with macOS's own tools: what the pane shows for each.
  const { execFileSync } = require('child_process')
  fs.writeFileSync(path.join(docs, 'x.html'), '<h1>Titolo Word</h1><p>Un paragrafo con <b>grassetto</b>.</p>')
  execFileSync('/usr/bin/textutil', ['-convert', 'docx', path.join(docs, 'x.html'), '-output', path.join(docs, 'lettera.docx')])
  execFileSync('/usr/bin/python3', ['-I', path.join(__dirname, 'fixtures', 'make-xlsx.py'), path.join(docs, 'conti.xlsx')])
  execFileSync('/usr/bin/sips', ['-s', 'format', 'png', path.join(__dirname, 'fixtures', 'two-pages.pdf'), '--out', path.join(dir, 'page.png')], { stdio: 'ignore' })
  execFileSync('/usr/bin/sips', ['-s', 'format', 'heic', path.join(dir, 'page.png'), '--out', path.join(docs, 'foto.heic')], { stdio: 'ignore' })
  fs.writeFileSync(path.join(docs, 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><circle cx="20" cy="20" r="18" fill="#8a6239"/></svg>')
  execFileSync('/usr/bin/zip', ['-qj', path.join(docs, 'pacchetto.zip'), path.join(docs, 'notes.md')])
  const ffmpeg = ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg'].find(f => fs.existsSync(f))
  if (ffmpeg) {
    execFileSync(ffmpeg, ['-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=25:duration=3', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', path.join(docs, 'clip.mp4')])
    execFileSync(ffmpeg, ['-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', path.join(docs, 'tono.mp3')])
  }
  const seen = []
  // Wait for this very file to be on show: Quick Look and sips take their time, and a stale pane must not pass.
  const show = async (name, wait = 15000) => {
    const res = await cli('show', path.join(docs, name)); assert.ok(res.ok, `${name}: ${res.err}`)
    const t = Date.now()
    while (Date.now() - t < wait) {
      const title = await js(`document.querySelector('.file-preview-title')?.firstChild?.textContent || ''`)
      if (seen.at(-1) !== title) seen.push(title)
      if (title === name && await js(`!!document.querySelector('.file-preview :is(iframe, video, audio, img, .monaco-editor, canvas), .file-preview > p')`)) return
      await delay(150)
    }
    throw new Error(`${name} never showed; titles seen: ${seen.join(' → ')}; status: ${await js(`document.querySelector('.files-status')?.textContent`)}`)
  }
  const kind = () => js(`(() => { const p = document.querySelector('.file-preview'); return p.querySelector('iframe.file-html') ? 'html' : p.querySelector('video') ? 'video' : p.querySelector('audio') ? 'audio' : p.querySelector('img') ? 'image:' + p.querySelector('img').src.slice(5, p.querySelector('img').src.indexOf(';')) : p.querySelector('.monaco-editor') ? 'text' : (document.querySelector('.files-status')?.textContent || 'none') })()`)
  await show('lettera.docx'); assert.equal(await kind(), 'html')
  assert.match(await js(`document.querySelector('iframe.file-html').srcdoc`), /Titolo Word/)
  assert.equal(await js(`document.querySelector('iframe.file-html').getAttribute('sandbox')`), '', 'no scripts in a document preview')
  fs.writeFileSync(path.join(os.tmpdir(), 'terminai-show-docx.png'), (await win.webContents.capturePage(undefined, { stayHidden: true })).toPNG())
  await show('conti.xlsx'); assert.equal(await kind(), 'html'); assert.match(await js(`document.querySelector('iframe.file-html').srcdoc`), /Railway[\s\S]*Totale/)
  await show('foto.heic'); assert.equal(await kind(), 'image:image/jpeg')
  await show('logo.svg'); assert.equal(await kind(), 'image:image/svg+xml')
  await show('pacchetto.zip'); assert.match(await js(`document.querySelector('.file-preview').textContent`), /macOS has no preview for this kind of file\.Open|Open with the default app[\s\S]*macOS has no preview/, 'no preview: said so, with the button to open it elsewhere')
  if (ffmpeg) {
    await show('clip.mp4'); assert.equal(await kind(), 'video')
    const played = await js(`new Promise(done => { const v = document.querySelector('.file-preview video'); const go = () => { v.currentTime = 2; v.addEventListener('seeked', () => done({ duration: Math.round(v.duration), at: Math.round(v.currentTime) }), { once: true }) }; v.readyState >= 1 ? go() : v.addEventListener('loadedmetadata', go, { once: true }); setTimeout(() => done({ error: v.error && v.error.code, ready: v.readyState }), 8000) })`)
    assert.deepEqual(played, { duration: 3, at: 2 }, `video: ${JSON.stringify(played)}`)
    fs.writeFileSync(path.join(os.tmpdir(), 'terminai-show-video.png'), (await win.webContents.capturePage(undefined, { stayHidden: true })).toPNG())
    await show('tono.mp3'); assert.equal(await kind(), 'audio')
    assert.equal(await js(`new Promise(done => { const a = document.querySelector('.file-preview audio'); a.readyState >= 1 ? done(Math.round(a.duration)) : a.addEventListener('loadedmetadata', () => done(Math.round(a.duration)), { once: true }); setTimeout(() => done(-1), 8000) })`), 2)
  }
  r = await cli('show', path.join(docs, 'missing.pdf')); assert.equal(r.ok, false); assert.match(r.err, /No such file/)
  r = await cli('show', docs); assert.equal(r.ok, false, 'a folder is not a file'); assert.match(r.err, /No such file/)
  console.log(`PASS show file: PDF, text, Word, Excel, HEIC, SVG, zip${ffmpeg ? ', video (plays and seeks), audio' : ' (no ffmpeg: video and audio skipped)'} in the Files pane beside the terminal; missing paths and folders refused`)
  fs.rmSync(dir, { recursive: true, force: true }); app.quit()
})().catch(e => { console.error(e); fs.rmSync(dir, { recursive: true, force: true }); app.exit(1) }) }))
setTimeout(() => { console.error('show timeout'); app.exit(1) }, 60000).unref()
require(path.join(__dirname, '../out/main/index.js'))
