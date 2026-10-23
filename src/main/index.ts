import { app, BrowserWindow, ipcMain, dialog, shell, nativeTheme, protocol, net, clipboard, nativeImage, ClipboardItem, Notification } from 'electron'
import { join, basename, resolve, sep, dirname, extname } from 'node:path'
import { createReadStream, existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { chmod, copyFile, mkdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { Readable } from 'node:stream'
import { ProjectFiles, MEDIA_SCHEME, MEDIA_TYPES, mediaFile } from './project-files'
import { DEFAULT_WORKSPACE_URL } from '../shared/workspace'
import { workspaceState, workspaceLogin, workspaceLogout, workspaceRequest } from './workspace'
import { setupAssignedMcps } from './mcp-setup'
import { createBrowserPane } from './browser'
import { startBrowserBridge, registerBrowserMcp } from './browser-bridge'
import { agentGuide, todoMap, writeAgentGuide } from './agent-guide'
import { startControl, controlReply } from './control'
import { createTodos, DEFAULT_TASKS_REMOTE } from './todos'
import { createAccounts, chromeProfiles } from './accounts'
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
import type { QuestionKind } from '../shared/questions'

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
// Made in registerIpc; the control channel uses it too, for `terminai todo start|done|reopen|add|about`.
let todos: ReturnType<typeof createTodos>
/** The agents' global instructions: the real files only for the installed app, tests name theirs with CLAUDE_CONFIG_DIR and CODEX_HOME. */
function guideFiles(): string[] {
  const installed = app.getPath('userData') === join(app.getPath('appData'), 'clipwave-term')
  const claudeHome = process.env.CLAUDE_CONFIG_DIR || (installed ? join(homedir(), '.claude') : '')
  const codexHome = process.env.CODEX_HOME || (installed ? join(homedir(), '.codex') : '')
  return [claudeHome && join(claudeHome, 'CLAUDE.md'), codexHome && join(codexHome, 'AGENTS.md')].filter(Boolean)
}
/** The terminai commands and the map of this Mac's To-do pages, at start and whenever the lists or the user change. */
function writeGuides(): void {
  const guide = agentGuide(todos ? todoMap(store.load().tasksUser, todos.pages()) : '')
  for (const file of guideFiles()) try { writeAgentGuide(file, guide) } catch (e) { console.error('[agent-guide]', e) }
}

// Must run before app-ready, or the scheme is treated as opaque and <audio>
// refuses to seek within it.
protocol.registerSchemesAsPrivileged([
  {
    scheme: voice.AUDIO_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
  { scheme: MEDIA_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
])

/** The video or audio file the Files pane is playing, by its token only; ranges, so the player can seek. */
function registerMediaProtocol(): void {
  protocol.handle(MEDIA_SCHEME, async (request) => {
    const file = mediaFile(new URL(request.url).pathname.slice(1))
    if (!file) return new Response('not found', { status: 404 })
    const size = (await stat(file)).size, type = MEDIA_TYPES[extname(file).slice(1).toLowerCase()] ?? 'application/octet-stream'
    const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get('range') ?? '')
    const start = range ? (range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]))) : 0
    const end = range && range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1
    const body = Readable.toWeb(createReadStream(file, { start, end })) as unknown as BodyInit
    return new Response(body, { status: range ? 206 : 200, headers: { 'content-type': type, 'content-length': String(end - start + 1), 'accept-ranges': 'bytes', ...(range ? { 'content-range': `bytes ${start}-${end}/${size}` } : {}) } })
  })
}

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
  // Livio's earlier build marked a run with `alive`; one left behind is a crash of that build, read once and dropped.
  const legacyMarker = join(app.getPath('userData'), 'alive')
  crashedLastRun = existsSync(aliveMarker()) || existsSync(legacyMarker)
  rmSync(legacyMarker, { force: true })
  mkdirSync(app.getPath('userData'), { recursive: true })
  writeFileSync(aliveMarker(), String(process.pid))
  registerAudioProtocol()
  registerMediaProtocol()
  registerIpc()
  createWindow()
  // Local command channel for the terminal tabs, used by resources/terminai.cjs.
  void startControl(app.getPath('userData'), { window: () => win, activeTab: () => activeTabId, focused: (id) => { activeTabId = id }, show: queueOpenFile,
    todo: { track: (action, query, session) => todos.track(action, query, session), add: (to, title, note) => todos.addTo(to, title, note), about: (list, text) => todos.describeList(list, text, true) } })
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
    // The terminai commands in the agents' own global instructions, the same way.
    writeGuides()
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
  // Only from the pane's own button: an app outside TerminAI when the user asks for one.
  appIpc.handle('project:openExternal', async (_event, path: string) => { const error = await shell.openPath(await projectFiles.resolved(path)); if (error) throw new Error(error) })
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
  appIpc.on('pty:question', (_e, { id, kind }: { id: string; kind: QuestionKind | null }) => ptys.setQuestion(id, kind))
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
  todos = createTodos(app.getPath('userData'), {
    // The test build never falls back to the real shared repo: it syncs only with TERMINAI_TASKS_REMOTE.
    remote: process.env.TERMINAI_TASKS_REMOTE || (process.env.TERMINAI_TEST_BUILD ? '' : DEFAULT_TASKS_REMOTE),
    user: () => store.load().tasksUser,
    changed: todosChanged,
    listsChanged: writeGuides,
    // The other Mac's edits, pulled by a sync: one notice per sync, a click opens the To-do sheet.
    notify: ({ by, changed, removed, mentioned }) => {
      const name = by === 'ilai' ? 'Ilai' : 'Matteo', count = changed.length + removed.length
      const ai = changed.length > 0 && changed.every(task => task.updatedVia === 'ai') ? `${name}’s AI` : name
      const body = mentioned?.length ? `${ai} tagged you in “${mentioned[0].title}”${mentioned.length > 1 ? ` and ${mentioned.length - 1} more` : ''}`
        : changed.length === 1 && !removed.length ? `${ai} changed “${changed[0].title}”` : removed.length === 1 && !changed.length ? `${name} deleted “${removed[0]}”` : `${ai} changed ${count} shared tasks`
      // Inside TerminAI too, top right: the system notice is easy to miss while working in a tab.
      if (win && !win.isDestroyed()) win.webContents.send('todos:notice', { text: body, mention: !!mentioned?.length })
      if (!Notification.isSupported()) return
      const note = new Notification({ title: 'To-do', body })
      note.on('click', () => { if (!win || win.isDestroyed()) return; win.show(); win.webContents.send('todos:open') })
      note.show()
    },
  })
  const scopeOf = (scope: unknown): TaskScope => {
    if (scope !== 'personal' && scope !== 'shared') throw new Error('Invalid task list')
    return scope
  }
  appIpc.handle('todos:list', () => todos.list())
  appIpc.handle('todos:save', (_e, scope: unknown, input: TaskInput) => todos.save(scopeOf(scope), input && typeof input === 'object' ? input : {}))
  appIpc.handle('todos:saveMany', (_e, scope: unknown, inputs: unknown) => todos.saveMany(scopeOf(scope), Array.isArray(inputs) ? inputs.map(input => input && typeof input === 'object' ? input : {}) : []))
  appIpc.handle('todos:remove', (_e, scope: unknown, id: string) => todos.remove(scopeOf(scope), id))
  appIpc.handle('todos:removeMany', (_e, scope: unknown, ids: unknown) => todos.removeMany(scopeOf(scope), Array.isArray(ids) ? ids : []))
  appIpc.handle('todos:restore', (_e, scope: unknown, tasks: unknown) => todos.restore(scopeOf(scope), Array.isArray(tasks) ? tasks : []))
  appIpc.handle('todos:move', (_e, from: unknown, id: string, assignee?: Task['assignee'], order?: number, into?: string) => todos.move(scopeOf(from), id, assignee, order, into))
  appIpc.handle('todos:addList', (_e, name: unknown) => todos.addList(name))
  appIpc.handle('todos:renameList', (_e, id: unknown, name: unknown) => todos.renameList(id, name))
  appIpc.handle('todos:removeList', (_e, id: unknown) => todos.removeList(id))
  appIpc.handle('todos:restoreList', (_e, id: unknown) => todos.restoreList(id))
  appIpc.handle('todos:describeList', (_e, id: unknown, about: unknown) => todos.describeList(id, about))
  appIpc.handle('todos:sync', () => todos.sync())
  appIpc.handle('todos:markSeen', (_e, ids: unknown) => todos.markSeen(Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : []))
  appIpc.handle('todos:history', (_e, id: unknown) => todos.history(String(id)))
  appIpc.handle('todos:activity', () => todos.activity())
  // Pictures for a task's note, small enough for the repo: at most 2000 px a side, PNG while that stays
  // under 1.5 MB (a screenshot keeps its text sharp), else JPEG.
  async function todoImage(bytes: Buffer): Promise<[Buffer, 'png' | 'jpg']> {
    let image = nativeImage.createFromBuffer(bytes)
    if (image.isEmpty()) {
      // HEIC and the like: macOS's sips turns them into a JPEG first.
      const tmp = join(app.getPath('temp'), `terminai-image-${process.pid}-${Date.now()}`)
      try { writeFileSync(tmp, bytes); await execFileAsync('/usr/bin/sips', ['-s', 'format', 'jpeg', tmp, '--out', `${tmp}.jpg`], { timeout: 30_000 }); image = nativeImage.createFromPath(`${tmp}.jpg`) }
      catch {} finally { rmSync(tmp, { force: true }); rmSync(`${tmp}.jpg`, { force: true }) }
    }
    if (image.isEmpty()) throw Error('That file is not an image.')
    const { width, height } = image.getSize()
    if (Math.max(width, height) > 2000) image = image.resize(width >= height ? { width: 2000, quality: 'best' } : { height: 2000, quality: 'best' })
    const png = image.toPNG()
    return png.length <= 1.5 * 1024 * 1024 ? [png, 'png'] : [image.toJPEG(85), 'jpg']
  }
  appIpc.handle('todos:addImage', async (_e, scope: unknown, id: unknown, bytes: unknown) => {
    if (!(bytes instanceof Uint8Array) || !bytes.byteLength || bytes.byteLength > 40 * 1024 * 1024) throw Error('That image is too large.')
    return todos.addImage(scopeOf(scope), String(id), ...await todoImage(Buffer.from(bytes)))
  })
  appIpc.handle('todos:pickImages', async (_e, scope: unknown, id: unknown) => {
    const { canceled, filePaths } = await dialog.showOpenDialog(win!, { title: 'Add images to the task', properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'heic', 'heif', 'gif', 'webp', 'tiff', 'tif', 'bmp'] }] })
    let list = todos.list()
    if (!canceled) for (const path of filePaths) list = await todos.addImage(scopeOf(scope), String(id), ...await todoImage(await readFile(path)))
    return list
  })
  appIpc.handle('todos:removeImage', (_e, scope: unknown, id: unknown, name: unknown) => todos.removeImage(scopeOf(scope), String(id), String(name)))
  appIpc.handle('todos:imageThumb', (_e, scope: unknown, id: unknown, name: unknown) => {
    const file = todos.imagePath(scopeOf(scope), String(id), String(name)), image = file ? nativeImage.createFromPath(file) : null
    if (!image || image.isEmpty()) return ''
    return (image.getSize().height > 240 ? image.resize({ height: 240, quality: 'good' }) : image).toDataURL()
  })
  appIpc.handle('todos:imageFull', (_e, scope: unknown, id: unknown, name: unknown) => {
    const file = todos.imagePath(scopeOf(scope), String(id), String(name)), image = file ? nativeImage.createFromPath(file) : null
    return !image || image.isEmpty() ? '' : image.toDataURL()
  })
  // Or in the Files pane, the way `terminai show` opens a file.
  appIpc.handle('todos:showImage', (_e, scope: unknown, id: unknown, name: unknown) => {
    const file = todos.imagePath(scopeOf(scope), String(id), String(name))
    if (!file) throw Error('That image has not arrived on this Mac yet.')
    queueOpenFile(file)
  })
  // Pull on open and every 3 minutes, quietly; pushes happen on every change.
  void todos.sync()
  setInterval(() => void todos.sync(), 3 * 60_000)

  // ---- Claude accounts ---------------------------------------------------
  const accounts = createAccounts(app.getPath('userData'), {
    changed: () => { if (win && !win.isDestroyed()) win.webContents.send('accounts:changed') },
    flowChanged: (flow) => { if (win && !win.isDestroyed()) win.webContents.send('accounts:flow', flow) },
  })
  appIpc.handle('accounts:list', () => accounts.listing())
  appIpc.handle('accounts:forTab', (_e, ptyId: unknown) => accounts.forTab(String(ptyId)))
  appIpc.handle('accounts:use', (_e, ptyId: unknown, id: unknown) => accounts.use(String(ptyId), String(id)))
  appIpc.handle('accounts:mode', (_e, mode: unknown) => accounts.setMode(mode))
  appIpc.handle('accounts:default', (_e, id: unknown) => accounts.setDefault(String(id)))
  appIpc.handle('accounts:add', (_e, label: unknown) => accounts.add(label))
  appIpc.handle('accounts:open', (_e, flowId: unknown, profileDir: unknown) => accounts.openInChrome(String(flowId), String(profileDir)))
  appIpc.handle('accounts:cancel', (_e, flowId: unknown) => accounts.cancel(String(flowId)))
  appIpc.handle('accounts:remove', (_e, id: unknown) => accounts.remove(String(id)))
  appIpc.handle('accounts:rename', (_e, id: unknown, label: unknown) => accounts.rename(String(id), label))
  appIpc.handle('accounts:chromeProfiles', () => chromeProfiles())
  appIpc.handle('accounts:refreshUsage', () => accounts.refreshUsage())

  // ---- prefs -------------------------------------------------------------
  appIpc.handle('prefs:get', () => store.load())
  appIpc.handle('prefs:set', (_e, patch: Partial<Prefs>) => {
    const next = store.save(patch)
    // The first clone waits for the user to say who they are in the To-do sheet.
    // Private tasks are per user: the sheet reloads them once the new name is saved.
    if (patch.tasksUser) { todosChanged(); void todos.sync(); writeGuides() }
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
