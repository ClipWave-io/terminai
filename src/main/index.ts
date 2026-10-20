import { app, BrowserWindow, ipcMain, dialog, shell, nativeTheme, protocol, net, clipboard, nativeImage, ClipboardItem } from 'electron'
import { join, basename, resolve, sep, dirname } from 'node:path'
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { chmod, copyFile, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { ProjectFiles } from './project-files'
import { DEFAULT_WORKSPACE_URL } from '../shared/workspace'
import { workspaceState, workspaceLogin, workspaceLogout, workspaceRequest } from './workspace'
import { setupAssignedMcps } from './mcp-setup'
import { createBrowserPane } from './browser'
import { startBrowserBridge, registerBrowserMcp } from './browser-bridge'
import { startControl, controlReply } from './control'
import { createTodos, DEFAULT_TASKS_REMOTE } from './todos'
import * as ptys from './pty'
import * as store from './store'
import * as voice from './voice'
import { availableVoices } from './tts/say'
import {
  hasKey as hasElevenKey,
  listVoices as listElevenVoices,
  forgetKey as forgetElevenKey,
  KEYCHAIN_SERVICE,
} from './tts/elevenlabs'
import * as localTts from './tts/local'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
import { getTheme } from '../shared/themes'
import type { Prefs, Task, TaskInput, TaskScope, VoicePrefs } from '../shared/types'

/** Injected by electron-vite at build time; see electron.vite.config.ts. */
declare const __REPO_ROOT__: string

const openFiles = new Map<string,string>()
function queueOpenFile(path: string) {
  const id = crypto.randomUUID(); openFiles.set(id, resolve(path))
  if (app.isReady() && (!win || win.isDestroyed())) createWindow()
  if (win && !win.isDestroyed()) { win.webContents.send('project:open-request', id); win.show(); win.focus() }
}
app.on('open-file', (event, path) => { event.preventDefault(); queueOpenFile(path) })
let win: BrowserWindow | null = null
let browser: ReturnType<typeof createBrowserPane> | null = null
/** Tracked so a voice clip can be attributed to the tab that likely produced it. */
let activeTabId: string | null = null

// Must run before app-ready, or the scheme is treated as opaque and <audio>
// refuses to seek within it.
protocol.registerSchemesAsPrivileged([
  {
    scheme: voice.AUDIO_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
])

/** Serves only files that really live inside the voice cache directory. */
function registerAudioProtocol(): void {
  protocol.handle(voice.AUDIO_SCHEME, (request) => {
    const dir = voice.cacheDir()
    const name = basename(decodeURIComponent(new URL(request.url).pathname))
    const file = resolve(dir, name)
    if (file !== resolve(dir, basename(file)) || !file.startsWith(dir + sep)) {
      return new Response('forbidden', { status: 403 })
    }
    return net.fetch(pathToFileURL(file).toString())
  })
}

function createWindow(): void {
  const prefs = store.load()
  const theme = getTheme(prefs.theme)

  win = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 720,
    minHeight: 420,
    show: false,
    // Rounded, chromeless shell with the traffic lights floated over the rail.
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 18 },
    backgroundColor: theme.background,
    vibrancy: theme.dark ? 'under-window' : 'sidebar',
    visualEffectState: 'active',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // A summary must play the moment it arrives; there is no click to gate it on.
      autoplayPolicy: 'no-user-gesture-required',
    },
  })

  // App shell must never navigate into remote content with its privileged preload.
  win.webContents.on('will-navigate', event => event.preventDefault())
  win.webContents.on('will-redirect', event => event.preventDefault())
  browser = createBrowserPane(win)

  win.webContents.on('will-prevent-unload', event => {
    const choice = dialog.showMessageBoxSync(win!, { type: 'warning', buttons: ['Keep editing', 'Discard changes'], defaultId: 0, cancelId: 0, message: 'You have unsaved file changes.' })
    if (choice === 1) event.preventDefault()
  })
  win.on('enter-full-screen', () => win?.webContents.send('window:fullscreen', true))
  win.on('leave-full-screen', () => win?.webContents.send('window:fullscreen', false))
  // A test build must not take focus from the real app the user is typing in.
  win.once('ready-to-show', () => process.env.TERMINAI_TEST_BUILD ? win?.showInactive() : win?.show())

  // Links in terminal output open in the real browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  voice.startWatching(
    win.webContents,
    () => store.load().voice,
    () => ptys.liveIds().map((id) => ({ id, cwd: ptys.cwdOf(id) })),
  )
}

let crashedLastRun = false
const aliveMarker = () => join(app.getPath('userData'), 'running.marker')
app.whenReady().then(() => {
  crashedLastRun = existsSync(aliveMarker())
  mkdirSync(app.getPath('userData'), { recursive: true })
  writeFileSync(aliveMarker(), String(process.pid))
  registerAudioProtocol()
  registerIpc()
  createWindow()
  // Local command channel for the terminal tabs, used by resources/terminai.cjs.
  void startControl(app.getPath('userData'), { window: () => win, activeTab: () => activeTabId, focused: (id) => { activeTabId = id } })
    .then((control) => app.once('before-quit', control.close))
    .catch((err) => console.error('[control] could not start:', err))
  void (async()=>{
    const directory=app.getPath('userData'),script=join(directory,'browser-mcp.cjs')
    await copyFile(app.isPackaged?join(app.getAppPath(),'resources/browser-mcp.cjs'):join(__dirname,'../../resources/browser-mcp.cjs'),script)
    // node cannot run a script inside app.asar from a shell, so every PTY gets a real copy on PATH.
    const cli=join(directory,'bin','terminai')
    await mkdir(join(directory,'bin'),{recursive:true})
    await copyFile(app.isPackaged?join(app.getAppPath(),'resources/terminai.cjs'):join(__dirname,'../../resources/terminai.cjs'),cli)
    await chmod(cli,0o755)
    const bridge=await startBrowserBridge(directory,async(command,args,owner)=>{
      if(!browser||!win||win.isDestroyed())throw Error('Open the TerminAI window to browse.')
      const known=store.load().tabs.some(tab=>(tab.browserKey||tab.ptyId)===owner)
      if(!known)throw Error('Unknown TerminAI coding session. Reopen the terminal tab.')
      return browser.automate(command,args,owner)
    })
    app.once('will-quit',bridge.close)
    // Only the installed app, with its default data folder, may write the user's real Codex config:
    // tests and the test build point userData elsewhere and must pass CODEX_HOME explicitly.
    const codexHome=process.env.CODEX_HOME||(directory===join(app.getPath('appData'),'clipwave-term')?join(homedir(),'.codex'):'')
    if(codexHome)registerBrowserMcp(join(codexHome,'config.toml'),process.execPath,script,join(directory,'browser-bridge.json'))
  })().catch(()=>{console.error('Embedded browser MCP setup needs attention. See the browser setup guide.')})

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  voice.stopWatching()
  if (process.platform !== 'darwin') {
    ptys.killAll()
    app.quit()
    return
  }
  // On macOS closing the window is not quitting. Leave every shell running and
  // only drop the window binding: reopening from the Dock then adopts the same
  // sessions, mid-command and mid-conversation, instead of restarting them.
  ptys.detachAll()
})

app.on('before-quit', () => {
  // Persist the last main-process identity before killing PTYs. Renderer polling
  // may not have saved the latest /new or /resume yet.
  const prefs = store.load()
  store.save({ tabs: prefs.tabs.map(tab => {
    if (!tab.ptyId) return tab
    const agent = ptys.agentOf(tab.ptyId)
    return agent.kind ? { ...tab, agent: agent.kind, agentSession: agent.sessionId || tab.agentSession, agentArgs: agent.args } : tab
  }) })
  voice.stopWatching()
  ptys.killAll()
})

// Every privileged channel accepts only the app shell's main frame, never a
// remote browser view or a subframe. Keep this boundary when adding channels.
function trusted(event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): boolean {
  return !!win && !win.isDestroyed() && event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame
}
const appIpc = {
  handle(channel: string, handler: (event: Electron.IpcMainInvokeEvent, ...args: any[]) => any) {
    ipcMain.handle(channel, (event, ...args) => {
      if (!trusted(event)) throw new Error('Untrusted IPC sender')
      return handler(event, ...args)
    })
  },
  on(channel: string, handler: (event: Electron.IpcMainEvent, ...args: any[]) => void) {
    ipcMain.on(channel, (event, ...args) => { if (trusted(event)) handler(event, ...args) })
  },
}

function registerIpc(): void {
  appIpc.handle('workspace:open-manager', () => shell.openExternal(DEFAULT_WORKSPACE_URL))
  appIpc.handle('workspace:state', () => workspaceState())
  appIpc.handle('workspace:login', (_event, input) => workspaceLogin(input))
  appIpc.handle('workspace:logout', () => workspaceLogout())
  appIpc.handle('workspace:request', (_event, path, method, body) => workspaceRequest(path, method, body))
  appIpc.handle('workspace:setup-tools', async (_event, companyId: string) => {
    if (typeof companyId !== 'string' || !/^[a-zA-Z0-9-]+$/.test(companyId)) throw new Error('Choose a company.')
    const response = await workspaceRequest(`/api/companies/${companyId}/catalog`)
    const catalog = Array.isArray(response) ? response : response.items ?? response.catalog ?? []
    return setupAssignedMcps(catalog.filter((row: any) => row.assigned === true).map((row: any) => row.id))
  })
  const projectFiles = new ProjectFiles()
  appIpc.handle('project:choose', async () => {
    const result = await dialog.showOpenDialog(win!, { properties: ['openDirectory'], title: 'Choose project folder to view' })
    return result.canceled ? null : projectFiles.selectRoot(result.filePaths[0])
  })
  appIpc.handle('project:pending', () => [...openFiles.keys()][0] || null)
  appIpc.handle('project:open', async (_event, id: string) => {
    const path = openFiles.get(id); if (!path) throw Error('File request expired.')
    await projectFiles.selectRoot(dirname(path))
    const listing = await projectFiles.list(''), preview = await projectFiles.preview(basename(path))
    openFiles.delete(id); return { listing, preview }
  })
  appIpc.handle('project:list', (_event, path: string) => projectFiles.list(path))
  appIpc.handle('project:save', (_event, path: string, content: string, version: string) => projectFiles.save(path, content, version))
  appIpc.handle('project:preview', (_event, path: string) => projectFiles.preview(path))
  appIpc.handle('window:fullscreen', () => win?.isFullScreen() || false)
  appIpc.handle('window:toggle-maximize', () => {
    if (!win) return
    if (win.isMaximized()) win.unmaximize(); else win.maximize()
  })
  appIpc.handle('browser:state', () => browser?.state())
  appIpc.handle('browser:action', (_event, type: string, input) => browser?.action(type, input))
  appIpc.handle('browser:navigate', (_event, url: unknown) => browser?.navigate(url))
  appIpc.handle('browser:command', (_event, command: string) => browser?.command(command))
  appIpc.handle('browser:layout', (_event, bounds) => browser?.layout(bounds))
  // ---- terminal ----------------------------------------------------------
  appIpc.handle('pty:create', (_e, opts: { cwd?: string; cols?: number; rows?: number; browserKey?: string }) =>
    ptys.createSession(opts ?? {}),
  )
  appIpc.on('pty:close', (_event, { id }: {id: string}) => ptys.closeSession(id))
  appIpc.handle('pty:unclose', (_event, { id }: {id: string}) => ptys.uncloseSession(id))
  appIpc.handle('pty:agent', (_event, { id }: {id: string}) => ptys.agentOf(id))
  appIpc.handle('pty:resumeCommand', (_event, desc) => ptys.resumeCommandFor(desc || {}))
  appIpc.on('pty:exec', (_event, { id, cmd }: {id: string; cmd: string}) => ptys.execWhenReady(id, String(cmd || '')))
  appIpc.handle('pty:size', (_event, { id }: {id: string}) => ptys.sizeOf(id))
  appIpc.on('tab:reply', (_event, reply) => controlReply(reply))
  appIpc.handle('clip:image', async (_event, path: string) => {
    if (typeof path !== 'string') return false
    const image = nativeImage.createFromPath(path)
    if (image.isEmpty()) return false
    await clipboard.write([new ClipboardItem({ 'image/png': new Blob([new Uint8Array(image.toPNG())], { type: 'image/png' }) })]); return true
  })
  appIpc.handle('app:launch', () => ({ crashed: crashedLastRun }))
  appIpc.handle('pty:list', () => ptys.list())
  appIpc.handle('pty:attach', (e, { id }: { id: string }) => ptys.attach(e.sender, id))
  appIpc.on('pty:write', (_e, { id, data }: { id: string; data: string }) => ptys.write(id, data))
  appIpc.on('pty:resize', (_e, { id, cols, rows }: { id: string; cols: number; rows: number }) =>
    ptys.resize(id, cols, rows),
  )
  appIpc.on('pty:kill', (_e, { id }: { id: string }) => ptys.kill(id))
  appIpc.handle('pty:process', (_e, { id }: { id: string }) => ptys.foregroundProcess(id))
  appIpc.handle('pty:status', (_e, { id }: { id: string }) => ptys.statusOf(id))
  appIpc.handle('pty:usedClaude', (_e, { id }: { id: string }) => ptys.usedClaude(id))
  appIpc.handle('pty:cwd', (_e, { id }: { id: string }) => ptys.cwdOf(id))
  appIpc.handle('pty:claudeSession', (_e, { id }: { id: string }) => ptys.claudeSessionOf(id))
  appIpc.handle(
    'pty:recentSessions',
    (_e, { cwd, limit }: { cwd: string; limit: number }) => ptys.recentClaudeSessions(cwd, limit),
  )
  appIpc.handle('pty:canResume', (_e, { sessionId }: { sessionId: string }) =>
    ptys.claudeSessionExists(sessionId),
  )
  appIpc.on('tab:active', (_e, { id }: { id: string | null }) => {
    activeTabId = id
  })

  // ---- to-do -------------------------------------------------------------
  const todosChanged = () => { if (win && !win.isDestroyed()) win.webContents.send('todos:changed') }
  const todos = createTodos(app.getPath('userData'), {
    // The test build never falls back to the real shared repo: it syncs only with TERMINAI_TASKS_REMOTE.
    remote: process.env.TERMINAI_TASKS_REMOTE || (process.env.TERMINAI_TEST_BUILD ? '' : DEFAULT_TASKS_REMOTE),
    user: () => store.load().tasksUser,
    changed: todosChanged,
  })
  const scopeOf = (scope: unknown): TaskScope => {
    if (scope !== 'personal' && scope !== 'shared') throw new Error('Invalid task list')
    return scope
  }
  appIpc.handle('todos:list', () => todos.list())
  appIpc.handle('todos:save', (_e, scope: unknown, input: TaskInput) => todos.save(scopeOf(scope), input && typeof input === 'object' ? input : {}))
  appIpc.handle('todos:remove', (_e, scope: unknown, id: string) => todos.remove(scopeOf(scope), id))
  appIpc.handle('todos:move', (_e, from: unknown, id: string, assignee?: Task['assignee']) => todos.move(scopeOf(from), id, assignee))
  appIpc.handle('todos:sync', () => todos.sync())
  // Pull on open and every 3 minutes, quietly; pushes happen on every change.
  void todos.sync()
  setInterval(() => void todos.sync(), 3 * 60_000)

  // ---- prefs -------------------------------------------------------------
  appIpc.handle('prefs:get', () => store.load())
  appIpc.handle('prefs:set', (_e, patch: Partial<Prefs>) => {
    const next = store.save(patch)
    // The first clone waits for the user to say who they are in the To-do sheet.
    // Private tasks are per user: the sheet reloads them once the new name is saved.
    if (patch.tasksUser) { todosChanged(); void todos.sync() }
    if (win && patch.theme) {
      const theme = getTheme(next.theme)
      win.setBackgroundColor(theme.background)
      // Keep the traffic lights and any native surfaces on the right side of
      // light/dark, or they invert against the new palette.
      nativeTheme.themeSource = theme.dark ? 'dark' : 'light'
      win.setVibrancy(theme.dark ? 'under-window' : 'sidebar')
    }
    return next
  })

  // ---- voice -------------------------------------------------------------
  appIpc.handle('voice:speak', async (_e, { text }: { text: string }) => {
    const prefs = store.load().voice
    const { path, engine } = await voice.synthesize(text, prefs)
    return voice.toClip(text, path, engine, activeTabId)
  })
  appIpc.handle('voice:voices', () => availableVoices())
  appIpc.handle('voice:hasElevenKey', () => hasElevenKey())
  appIpc.handle('voice:hasLocal', () => localTts.isAvailable())
  appIpc.handle('voice:elevenVoices', async () => {
    try {
      return { ok: true as const, voices: await listElevenVoices() }
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
    }
  })
  appIpc.handle('voice:setElevenKey', async (_e, { key }: { key: string }) => {
    const trimmed = key.trim()
    try {
      if (trimmed) {
        // -U updates in place if the item already exists.
        await execFileAsync('security', [
          'add-generic-password',
          '-U',
          '-s',
          KEYCHAIN_SERVICE,
          '-a',
          'clipwave-term',
          '-w',
          trimmed,
        ])
      } else {
        await execFileAsync('security', ['delete-generic-password', '-s', KEYCHAIN_SERVICE])
      }
      forgetElevenKey()
      return { ok: true as const }
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
    }
  })
  appIpc.handle('voice:save', async (_e, { path, text }: { path: string; text: string }) => {
    if (!win) return { saved: false }
    const suggested = `${text.slice(0, 48).replace(/[^\w\s-]/g, '').trim() || 'summary'}${
      path.endsWith('.mp3') ? '.mp3' : '.wav'
    }`
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      defaultPath: join(homedir(), 'Downloads', suggested),
    })
    if (canceled || !filePath) return { saved: false }
    await copyFile(path, filePath)
    return { saved: true, filePath }
  })

  // ---- design customisation ---------------------------------------------
  appIpc.handle('design:repo', () => {
    const root = typeof __REPO_ROOT__ === 'string' ? __REPO_ROOT__ : ''
    return { path: root, exists: Boolean(root) && existsSync(join(root, 'DESIGN.md')) }
  })

  // ---- misc --------------------------------------------------------------
  appIpc.handle('dialog:pickFolder', async () => {
    if (!win) return null
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      properties: ['openDirectory', 'createDirectory'],
    })
    return canceled ? null : (filePaths[0] ?? null)
  })
}

export type { VoicePrefs }

app.on('will-quit', () => { try { rmSync(aliveMarker(), { force: true }) } catch {} })
