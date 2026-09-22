import { BrowserWindow, WebContentsView, session, shell } from 'electron'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { browserUrl, type BrowserState } from '../shared/browser'

/** Remote content gets its own in-memory session, no app preload or Node bridge. */
export function createBrowserPane(win: BrowserWindow) {
  const isolated = session.fromPartition(`terminai-browser-${win.id}`)
  isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  isolated.setPermissionCheckHandler(() => false)
  isolated.on('will-download', event => event.preventDefault())
  const view = new WebContentsView({ webPreferences: {
    session: isolated, sandbox: true, contextIsolation: true, nodeIntegration: false,
    nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false, webSecurity: true,
    allowRunningInsecureContent: false, webviewTag: false,
  } })
  view.setVisible(false)
  win.contentView.addChildView(view)
  const contents = view.webContents
  let error = ''
  const state = (): BrowserState => ({ url: contents.getURL(), title: contents.getTitle(),
    loading: contents.isLoading(), canGoBack: contents.navigationHistory.canGoBack(), canGoForward: contents.navigationHistory.canGoForward(), error })
  const publish = () => { if (!win.isDestroyed() && !contents.isDestroyed()) win.webContents.send('browser:state', state()) }
  const navigate = async (input: unknown) => {
    try { const url = browserUrl(input); error = ''; await contents.loadURL(url) }
    catch (e) { error = e instanceof Error ? e.message : 'Unable to load page.' }
    publish()
  }
  const guard = (event: Electron.Event, url: string) => {
    try { browserUrl(url) } catch { event.preventDefault(); error = 'Only HTTP and HTTPS navigation is allowed.'; publish() }
  }
  contents.on('will-navigate', guard)
  contents.on('will-redirect', guard)
  contents.on('will-frame-navigate', (event) => guard(event, event.url))
  contents.setWindowOpenHandler(() => {
    error = 'This page requested a new window. Use Open in Chrome for popups or sign-in.'; publish()
    return { action: 'deny' }
  })
  contents.on('did-fail-load', (_event, code, description, _url, mainFrame) => {
    if (mainFrame && code !== -3) { error = `Page could not load: ${description}`; publish() }
  })
  contents.on('render-process-gone', () => { error = 'The page stopped responding. Reload to try again.'; publish() })
  contents.on('did-start-loading', publish)
  contents.on('did-stop-loading', publish)
  contents.on('did-navigate', publish)
  contents.on('did-navigate-in-page', publish)
  contents.on('page-title-updated', publish)
  win.once('closed', () => { if (!contents.isDestroyed()) contents.close() })
  return {
    state,
    navigate,
    layout(input: { x: number; y: number; width: number; height: number; visible: boolean }) {
      const [width, height] = win.getContentSize()
      if (!input || ![input.x, input.y, input.width, input.height].every(Number.isFinite)) throw new Error('Invalid browser bounds')
      const x = Math.max(0, Math.min(width, Math.round(input.x)))
      const y = Math.max(0, Math.min(height, Math.round(input.y)))
      view.setBounds({ x, y, width: Math.max(0, Math.min(width - x, Math.round(input.width))), height: Math.max(0, Math.min(height - y, Math.round(input.height))) })
      view.setVisible(input.visible === true && input.width > 0 && input.height > 0)
    },
    async command(action: string) {
      error = ''
      if (action === 'back' && contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack()
      else if (action === 'forward' && contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward()
      else if (action === 'reload') contents.reload()
      else if (action === 'external') {
        const url = browserUrl(contents.getURL())
        try { await promisify(execFile)('/usr/bin/open', ['-a', 'Google Chrome', url]) }
        catch { await shell.openExternal(url) }
      }
      publish()
    },
  }
}
