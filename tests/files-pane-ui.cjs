// The Files pane: a PDF with its toolbar (page you can type, fit width or page, rotate, the file's actions), and
// panes that move by dragging the grip at their top onto another pane.
// After `npx electron-vite build`: TERMINAI_TEST_BUILD=1 npx electron tests/files-pane-ui.cjs  ($SHOTS for screenshots)
const { app } = require('electron'), fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert/strict')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'terminai-files-pane-')); app.setPath('userData', dir)
fs.writeFileSync(path.join(dir, 'prefs.json'), JSON.stringify({ seenWelcome: true, tabs: [], voice: { enabled: false }, newTabAgent: 'none' }))
const delay = ms => new Promise(r => setTimeout(r, ms))
app.on('browser-window-created', (_e, win) => win.webContents.once('did-finish-load', () => { void (async () => {
  await delay(1500); win.setSize(1500, 900); const js = s => win.webContents.executeJavaScript(s)
  app.emit('open-file', { preventDefault() {} }, path.join(__dirname, 'fixtures/two-pages.pdf'))
  const pg = `(document.querySelector('.pdf-page input')?.value+' of '+((document.querySelector('.pdf-page')?.textContent||'').match(/of (\\d+)/)||[])[1])`
  for (let i = 0; i < 80 && await js(pg) !== '1 of 2'; i++) await delay(100)
  assert.equal(await js(pg), '1 of 2')
  await js(`document.querySelector('[aria-label="Next PDF page"]').click()`); await delay(300)
  assert.equal(await js(pg), '2 of 2', 'next page')
  await js(`document.querySelector('[aria-label="Fit page"]').click()`); await delay(300)
  assert.equal(await js(`document.querySelector('[aria-label="Fit page"]').getAttribute('aria-pressed')`), 'true', 'fit page')
  assert.ok(await js(`['Show in Finder','Open in the default app','Copy path','Rotate'].every(l=>!!document.querySelector('[aria-label="'+l+'"]'))`), 'file actions and rotate in the toolbar')
  if (process.env.SHOTS) { win.show(); win.webContents.invalidate(); await delay(700); fs.writeFileSync(path.join(process.env.SHOTS, 'pdf-toolbar.png'), (await win.webContents.capturePage()).toPNG()) }
  // Files dropped by its grip onto the terminal: they swap places.
  const order = `[...document.querySelectorAll('.workspace > .pane, .workspace > .files-slot')].map(e=>e.className.split(' ')[0]+':'+getComputedStyle(e).order).join()`
  const before = await js(order)
  await js(`(()=>{const dt=new DataTransfer(),g=document.querySelector('.files-slot > .pane-grip'),t=document.querySelector('.workspace > .pane');g.dispatchEvent(new DragEvent('dragstart',{bubbles:true,dataTransfer:dt}));t.dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer:dt}));t.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:dt}));g.dispatchEvent(new DragEvent('dragend',{bubbles:true,dataTransfer:dt}))})()`); await delay(400)
  const after = await js(order)
  assert.notEqual(after, before, `panes swapped (${before} -> ${after})`)
  // Settings › Appearance › Pane order moves them too.
  await js(`document.querySelector('[aria-label="Settings"]').click()`); await delay(400)
  await js(`[...document.querySelectorAll('.team-side button')].find(b=>b.textContent.trim()==='Appearance').click()`); await delay(300)
  const p0 = await js(`[...document.querySelectorAll('.st-pane')].map(p=>p.textContent.replace(/[‹›]/g,'')).join()`)
  await js(`document.querySelector('.st-pane [aria-label$="right"]:not(:disabled)').click()`); await delay(300)
  const p1 = await js(`[...document.querySelectorAll('.st-pane')].map(p=>p.textContent.replace(/[‹›]/g,'')).join()`)
  assert.notEqual(p1, p0, `pane order in Settings (${p0} -> ${p1})`)
  console.log(`PASS files pane: PDF pages, fit page, actions in the toolbar; panes swapped by their grip (${before} -> ${after})`); app.quit()
})().catch(e => { console.error(e); app.exit(1) }) }))
setTimeout(() => app.exit(1), 60000).unref(); require('../out/main/index.js')
