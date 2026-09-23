import { app, BrowserWindow, WebContentsView } from 'electron'
import { createServer } from 'node:http'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBrowserPane } from '../src/main/browser'
import { browserUrl } from '../src/shared/browser'
import * as pty from '@homebridge/node-pty-prebuilt-multiarch'

app.setPath('userData', mkdtempSync(join(tmpdir(), 'terminai-browser-smoke-')))
const waitFor = async (check: () => boolean) => {
  const until = Date.now() + 10000
  while (!check()) { if (Date.now() > until) throw new Error('Timed out'); await new Promise(r => setTimeout(r, 30)) }
}
void app.whenReady().then(async () => {
  const server = createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(`<title>${req.url}</title><h1>Browser smoke</h1><a href="/two">Next</a>`) })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const address = server.address() as { port: number }
  const origin = `http://127.0.0.1:${address.port}`
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true } })
  const browser = createBrowserPane(win)
  try {
    for (const input of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,x', 'https://user:pass@example.com']) assert.throws(() => browserUrl(input))
    assert.equal(browserUrl('localhost:3000'), 'http://localhost:3000/')
    await browser.navigate(`${origin}/one`)
    const view = win.contentView.children[0] as WebContentsView
    const wc = view.webContents
    assert.equal(browser.state().title, '/one')
    assert.deepEqual(await wc.executeJavaScript('[typeof process, typeof require, typeof window.term]'), ['undefined', 'undefined', 'undefined'])
    const prefs = wc.getLastWebPreferences()
    assert.equal(prefs.sandbox, true); assert.equal(prefs.nodeIntegration, false); assert.equal(prefs.contextIsolation, true); assert.equal(prefs.preload, undefined)
    await browser.navigate(`${origin}/two`)
    assert.equal(browser.state().canGoBack, true)
    await browser.command('back'); await waitFor(() => browser.state().url.endsWith('/one') && !browser.state().loading)
    assert.equal(browser.state().canGoForward, true)
    await browser.command('forward'); await waitFor(() => browser.state().url.endsWith('/two') && !browser.state().loading)
    await browser.command('reload'); await waitFor(() => !browser.state().loading)
    await browser.navigate('file:///etc/passwd'); assert.match(browser.state().error, /HTTP/); assert.equal(wc.getURL(), `${origin}/two`)
    await wc.executeJavaScript(`window.open('${origin}/popup')`)
    await waitFor(()=>browser.state().tabs?.length===2); assert.equal(BrowserWindow.getAllWindows().length, 1)
    const popup=browser.state().activeId!;await browser.action('close',{id:popup})
    assert.equal(await wc.executeJavaScript('Notification.requestPermission()'), 'denied')
    browser.layout({ x: 0, y: 0, width: 200, height: 200, visible: true }); assert.equal(view.getVisible(), true)
    browser.layout({ x: 0, y: 0, width: 0, height: 0, visible: false }); assert.equal(view.getVisible(), false)
    browser.selectSession('session-one')
    const first=await browser.action('new',{url:`${origin}/one`}) as any
    await waitFor(()=>!browser.state().loading)
    await browser.action('group',{id:first.id,name:'Research'})
    const second=await browser.action('new',{url:`${origin}/two`}) as any
    await browser.action('close',{id:first.id})
    assert.equal(browser.state().activeId,second.id,'closing another tab preserves the active tab')
    const personalView=win.contentView.children.at(-1) as WebContentsView
    await personalView.webContents.session.cookies.set({url:origin,name:'isolation',value:'personal'})
    const profile=await browser.action('profile',{name:'Work'}) as any
    await browser.action('use-profile',{id:profile.id})
    await browser.navigate(`${origin}/work`)
    const workView=win.contentView.children.at(-1) as WebContentsView
    assert.equal((await workView.webContents.session.cookies.get({url:origin,name:'isolation'})).length,0)
    const oneActive=browser.state().activeId
    browser.selectSession('session-two')
    assert.equal(browser.state().tabs?.length,0)
    await assert.rejects(()=>browser.automate('snapshot',{tabId:oneActive},'session-two'),/does not belong/)
    const automated=await browser.automate('open',{url:`${origin}/agent`},'session-two') as any
    await waitFor(()=>!browser.state().loading)
    const snapshot=await browser.automate('snapshot',{tabId:automated.id},'session-two') as any
    assert.match(snapshot.text,/Browser smoke/)
    browser.selectSession('session-one');assert.equal(browser.state().activeId,oneActive)
    const restoredWin=new BrowserWindow({show:false,webPreferences:{sandbox:true}})
    const restored=createBrowserPane(restoredWin);restored.selectSession('session-one')
    assert.equal(restored.state().tabs?.length,2);assert.equal(restored.state().profileId,profile.id)
    restoredWin.destroy()
    const privateTab = await browser.action('private') as any
    await browser.navigate(`${origin}/private-secret`)
    const privateView = win.contentView.children.at(-1) as WebContentsView
    assert.equal(privateView.webContents.session.storagePath, null)
    assert.equal((await privateView.webContents.session.cookies.get({url:origin,name:'isolation'})).length,0)
    await privateView.webContents.session.cookies.set({url:origin,name:'private-cookie',value:'secret'})
    const privateSession = privateView.webContents.session
    const sibling = await browser.action('new') as any
    assert.equal(sibling.profileId, privateTab.profileId)
    const persisted = readFileSync(join(app.getPath('userData'),'browser-workspace.json'),'utf8')
    assert.equal(persisted.includes('private-secret'), false)
    assert.equal(persisted.includes(privateTab.profileId), false)
    await browser.action('close',{id:privateTab.id})
    assert.equal((await privateSession.cookies.get({url:origin,name:'private-cookie'})).length,1)
    await browser.action('close',{id:sibling.id})
    assert.equal((await privateSession.cookies.get({url:origin,name:'private-cookie'})).length,0)
    assert.equal(browser.state().profiles?.some(p=>p.id===privateTab.profileId), false)
    let terminalOutput = ''
    const terminal = pty.spawn('/bin/zsh', ['-l'], { name: 'xterm-256color', cols: 80, rows: 24, env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' } })
    terminal.onData(data => { terminalOutput += data })
    terminal.write("printf 'PTY_SMOKE_%s\\n' 'OK'\r")
    await waitFor(() => terminalOutput.includes('PTY_SMOKE_OK'))
    terminal.resize(100, 30); terminal.kill()
    console.log('PASS: sandbox, denied permissions/schemes, sandboxed popup tabs, navigation, profiles/cookie isolation, session ownership, restore, layout, native login-shell PTY on Electron ' + process.versions.electron)
  } finally { win.destroy(); server.close(); app.quit() }
}).catch(error => { console.error(error); app.exit(1) })
