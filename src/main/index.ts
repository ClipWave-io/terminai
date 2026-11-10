import { readdir } from 'node:fs/promises'
import { app, BrowserWindow, Menu, ipcMain, dialog, shell, nativeTheme, protocol, net, clipboard, nativeImage, ClipboardItem, Notification } from 'electron'
import { join, basename, resolve, sep, dirname, extname } from 'node:path'
import { createReadStream, existsSync, mkdirSync, writeFileSync, rmSync, readFileSync, renameSync } from 'node:fs'
import { chmod, copyFile, mkdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { Readable } from 'node:stream'
import { ProjectFiles, MEDIA_SCHEME, MEDIA_TYPES, mediaFile } from './project-files'
import { DEFAULT_WORKSPACE_URL } from '../shared/workspace'
import { workspaceState, workspaceLogin, workspaceLogout, workspaceRequest, workspaceTasks, workspaceWorklog, teamOf, workspaceHandoff, workspaceAttach, teamChat, teamSend, teamSignal, teamFiles, teamFileChange, teamUpload, teamFetch, teamImage, workspaceFetchFile, workspaceHasAccount, workspaceBrowserLoginStart, workspaceBrowserLoginWait, workspaceBrowserLoginCancel } from './workspace'
import { setupAssignedMcps } from './mcp-setup'
import { startUpdates, checkForUpdatesNow } from './updates'
import { botAsk, botList, botSave, botRemove, botTest } from './connections'
import { createBrowserPane } from './browser'
import { startBrowserBridge, registerBrowserMcp } from './browser-bridge'
import { agentGuide, todoMap, writeAgentGuide, registerLogHook } from './agent-guide'
import { startControl, controlReply } from './control'
import { createTodos, DEFAULT_TASKS_REMOTE } from './todos'
import { workDay, handoff, today } from './worklog'
import { createBridge } from './teambridge'
import { memoryReport, watchMemory, sleep as sleepTabs, wake as wakeTab } from './memory'
import { memoryDetail, processInfo, stopProcess, storageReport } from './memoryDetail'
import { tabMode, defaultMode, repoOf } from './sharing'
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
// terminai://signin from the website: sign in with it, then the window refreshes its account (and shows the tour once).
app.setAsDefaultProtocolClient('terminai')
let pendingLink = ''
async function openLink(link: string) {
  if (!app.isReady()) { pendingLink = link; return }
  if (!win || win.isDestroyed()) createWindow()
  win?.show(); win?.focus()
  try { await workspaceHandoff(link); win?.webContents.send('workspace:signed-in') }
  catch (err) { dialog.showErrorBox('TerminAI could not sign in', err instanceof Error ? err.message : String(err)) }
}
app.on('open-url', (event, link) => { event.preventDefault(); void openLink(link) })
let win: BrowserWindow | null = null
let browser: ReturnType<typeof createBrowserPane> | null = null
/** Tracked so a voice clip can be attributed to the tab that likely produced it. */
// The menus and About panel say TerminAI; the data folder keeps the old package name, so nothing moves.
// Started from a TerminAI tab (a restart, `open -a`), the app would inherit that tab's settings: its proxy is the
// old relay, gone with the old app, and every git and network call would fail. Those belong to tabs, not to the app.
for (const name of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy', 'NODE_EXTRA_CA_CERTS']) {
  if (/127\.0\.0\.1|localhost|clipwave-term/.test(process.env[name] ?? '')) delete process.env[name]
}
for (const name of Object.keys(process.env)) if (/^TERMINAI_(TAB_ID|WORKSPACE_ID|CONTROL|CLI|TASKS_DIR|TODO_DIR|ACCOUNTS)$/.test(name)) delete process.env[name]
const dataFolder = app.getPath('userData')
app.setName('TerminAI')
app.setPath('userData', dataFolder)
let activeTabId: string | null = null
// Made in registerIpc; the control channel uses it too, for `terminai todo start|done|reopen|add|about`.
let todos: ReturnType<typeof createTodos>
let bridge: ReturnType<typeof createBridge> | null = null
// A failure in a background timer is logged, never shown as an error box every few seconds.
process.on('uncaughtException', err => console.error('[main] uncaught:', err))
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
  const claude = guideFiles().find(f => f.endsWith('CLAUDE.md'))
  if (claude) try { registerLogHook(join(dirname(claude), 'settings.json')) } catch (e) { console.error('[log-hook]', e) }
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
    () => ptys.liveIds().map((id) => ({ id, cwd: ptys.cwdOf(id), session: ptys.agentOf(id).sessionId || ptys.claudeSessionOf(id) })),
    tabDone,
  )
}

/**
 * After a restart brings a conversation back: Claude Code's "trust this folder?" screen is answered Yes (the folder
 * was already worked in), and a conversation that was mid-turn when TerminAI quit is told to carry on.
 */
const laterResume = new Map<string, { line: string; carryOn: boolean }>()
const claudeLine = (line: string) => /(^\S*claude\b|--(resume|continue)\b)/.test(line)
function startAgent(id: string, line: string, resume?: { carryOn: boolean }): void {
  if (claudeLine(line)) trustFolder(ptys.cwdOf(id))
  // A restored tab starts on a clean screen with a line saying it is coming back, not blank.
  ptys.execWhenReady(id, resume && line ? `clear; printf '\\n  \\033[2mResuming conversation…\\033[0m\\n'; ${line}` : line)
  if (resume || claudeLine(line)) afterResume(id, resume?.carryOn === true)
}
/** Opening a tab whose conversation waits since the restart starts it. */
function resumeLater(id: string): boolean {
  const job = laterResume.get(id)
  if (!job) return false
  laterResume.delete(id); startAgent(id, job.line, { carryOn: job.carryOn }); return true
}
function afterResume(id: string, carryOn: boolean): void {
  const started = Date.now()
  let nudged = false, quietSince = 0, trusted = false
  const tick = () => {
    if (nudged || Date.now() - started > 120_000 || !ptys.liveIds().includes(id)) return
    // Claude Code asks again in the home folder whatever its settings say. Choose option 1 by its number, so a
    // highlight resting on "No, exit" cannot pick the wrong one; only when option 1 is the trust answer.
    if (!trusted && /1\.\s*Yes, I trust this folder/.test(ptys.bufferOf(id).slice(-3000))) { trusted = true; ptys.write(id, '1'); setTimeout(tick, 1500); return }
    const agent = ptys.agentOf(id), status = ptys.statusOf(id)
    if (carryOn && agent.alive && status === 'waiting' && Date.now() - started > 6000) {
      if (!quietSince) quietSince = Date.now()
      if (Date.now() - quietSince > 3000) {
        nudged = true
        ptys.write(id, '\x1b[200~TerminAI restarted while you were working: continue where you left off.\x1b[201~')
        setTimeout(() => ptys.write(id, '\r'), 400)
        return
      }
    } else quietSince = 0
    setTimeout(tick, 700)
  }
  if (carryOn) setTimeout(tick, 1500)
}
/**
 * Claude Code asks "do you trust this folder?" the first time it runs in one; a tab coming back after a restart was
 * already working there, so the folder is marked trusted in ~/.claude.json before it starts (never by pressing keys:
 * the menu's highlighted answer is not always Yes).
 */
function trustFolder(cwd: string): void {
  const file = join(homedir(), '.claude.json')
  try {
    const d = JSON.parse(readFileSync(file, 'utf8'))
    const p = (d.projects ??= {})[cwd] ??= {}
    if (p.hasTrustDialogAccepted === true) return
    p.hasTrustDialogAccepted = true
    writeFileSync(`${file}.terminai-tmp`, JSON.stringify(d, null, 2), { mode: 0o600 }); renameSync(`${file}.terminai-tmp`, file)
  } catch (e) { console.warn('[resume] could not mark the folder trusted:', e instanceof Error ? e.message : e) }
}

/** A conversation finished a turn: a notice naming its tab with the one-line summary; a click opens that tab. */
/** macOS's notification permission for TerminAI (resources/notify.node): Electron itself never asks for it. */
type NotifyPermission = 'authorized' | 'denied' | 'provisional' | 'notDetermined' | 'other' | 'unavailable'
let notifyModule: { status: () => Promise<NotifyPermission>; ask: () => Promise<NotifyPermission> } | null | undefined
function notifyPermission(ask = false): Promise<NotifyPermission> {
  if (notifyModule === undefined) {
    try { notifyModule = require(app.isPackaged ? join(process.resourcesPath, 'app.asar.unpacked', 'resources', 'notify.node') : join(__dirname, '../../resources/notify.node')) }
    catch (e) { console.warn('[notify]', e instanceof Error ? e.message : e); notifyModule = null }
  }
  if (!notifyModule) return Promise.resolve('unavailable')
  return Promise.race([ask ? notifyModule.ask() : notifyModule.status(), new Promise<NotifyPermission>(r => setTimeout(() => r('other'), 120_000))])
}

function tabDone(tabId: string, text: string): void {
  if (!win || win.isDestroyed() || !Notification.isSupported() || !store.load().doneNotices) return
  // Already in front of it: nothing to tell.
  if (win.isFocused() && activeTabId === tabId) return
  const tab = store.load().tabs.find(t => t.ptyId === tabId)
  const name = tab?.customTitle || tab?.name || tab?.title || basename(ptys.cwdOf(tabId)) || 'Session'
  const note = new Notification({ title: `Done · ${name}`, body: text.length > 220 ? `${text.slice(0, 217)}…` : text, silent: true })
  note.on('click', () => {
    if (!win || win.isDestroyed()) return
    win.show(); win.focus()
    win.webContents.send('tab:request', { reqId: `notice-${Date.now()}`, kind: 'focus', input: { id: tabId } })
  })
  note.show()
}

let crashedLastRun = false
const aliveMarker = () => join(app.getPath('userData'), 'running.marker')
app.whenReady().then(() => {
  if (pendingLink) setTimeout(() => void openLink(pendingLink), 1500)
  // Electron's own menu, plus Check for Updates… under TerminAI.
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: app.name, submenu: [{ role: 'about' }, { label: 'Check for Updates…', click: () => void checkForUpdatesNow(win) }, { type: 'separator' },
      { role: 'services' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] },
    { role: 'fileMenu' }, { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' },
  ]))
  // The first launch after installing: macOS shows its Allow question for TerminAI's notifications once.
  if (!process.env.TERMINAI_TEST_BUILD) setTimeout(() => void notifyPermission().then(p => { if (p === 'notDetermined') void notifyPermission(true) }), 8000)
  startUpdates(() => win, { night: () => store.load().nightUpdates, busy: () => ptys.liveIds().some(id => ['working', 'question'].includes(ptys.statusOf(id))) })
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
  void startControl(app.getPath('userData'), { askGrok: async a => {
      const tab = typeof a.tab === 'string' && ptys.liveIds().includes(a.tab) ? a.tab : activeTabId ?? ''
      const saved = store.load().tabs.find(t => t.ptyId === tab)
      const session = tab && bridge ? bridge.conversationFor(tab) : null
      const r = await botAsk(a.question, a.agent, a.bot, saved?.customTitle || saved?.name || saved?.title || 'TerminAI session', session)
      // A reply-only bot may now answer into this conversation (for 30 minutes).
      if (r.keyId && session && bridge) await bridge.asked(r.keyId, session).catch(() => {})
      return { ok: r.ok, bot: r.bot, note: r.note }
    }, wake: id => resumeLater(id) || wakeTab(id), window: () => win, activeTab: () => activeTabId, focused: (id) => { activeTabId = id }, show: queueOpenFile,
    team: (a) => { if (!bridge) throw new Error('Not ready yet'); return bridge.command(a) },
    log: {
      day: async (day) => {
        const d = typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : today(), user = store.load().tasksUser
        const people = user ? await workspaceWorklog.get(user, d).catch(() => null) : null
        return { day: d, people: { ...(people ?? {}), ...(user ? { [user]: workDay(d, user, store.load().worklogSkip) } : {}) } }
      },
      hook: (session) => {
        const user = store.load().tasksUser
        if (!user) return {}
        const items = handoff(join(app.getPath('userData'), 'worklog-handoff.json'), typeof session === 'string' ? session : '', undefined, cwd => defaultMode(cwd) === 'shared')
        if (!items.length) return {}
        return { context: `TerminAI work log hand-off: finished work in this person's other conversations since the last hand-off, not yet matched to the To-do. `
          + `Before answering, quietly run \`terminai todo map\`; mark done any open task of the user's (theirs, Together or private) this work finished; for real work with no task, `
          + `add one with \`terminai todo add "<title>" --to ${user === 'livio' ? 'matteo' : 'ilai'} --note "Done <time>, logged by TerminAI"\` and mark it done. Group small turns into one task; `
          + `skip turns that did no work (questions, status). Say in one line what you changed.\n${items.join('\n')}` }
      },
    },
    todo: { track: (action, query, session) => todos.track(action, query, session), add: (to, title, note) => todos.addTo(to, title, note), request: (title, note, urgent) => todos.request(title, note, urgent), answer: (q, ok, reply) => todos.answer(q, ok, reply, 'ai'), about: (list, text) => todos.describeList(list, text, true) } })
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

// Quitting waits (at most 2 s) for the shells to finish exiting: an exit event that lands while Electron tears the
// process down throws inside node-pty and macOS reports TerminAI as crashed (every crash report since 2 Nov).
let shellsGone = false, quitting = false
app.on('before-quit', event => {
  if (shellsGone) return
  event.preventDefault()
  if (quitting) return
  quitting = true
  // Persist the last main-process identity before killing PTYs. Renderer polling
  // may not have saved the latest /new or /resume yet.
  const prefs = store.load()
  store.save({ tabs: prefs.tabs.map(tab => {
    if (!tab.ptyId) return tab
    const agent = ptys.agentOf(tab.ptyId)
    return agent.kind ? { ...tab, agent: agent.kind, agentSession: agent.sessionId || tab.agentSession, agentArgs: agent.args, wasWorking: agent.alive && ptys.statusOf(tab.ptyId) === 'working' } : { ...tab, wasWorking: false }
  }) })
  voice.stopWatching()
  ptys.killAll()
  const until = Date.now() + 2000
  const done = () => { if (ptys.exitsPending() && Date.now() < until) { setTimeout(done, 50); return } setTimeout(() => { shellsGone = true; app.quit() }, 150) }
  done()
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
  appIpc.handle('workspace:has-account', () => workspaceHasAccount())
  appIpc.handle('workspace:browser-login-start', (_event, url) => workspaceBrowserLoginStart(url))
  appIpc.handle('workspace:browser-login-wait', () => workspaceBrowserLoginWait())
  appIpc.handle('workspace:browser-login-cancel', () => workspaceBrowserLoginCancel())
  appIpc.handle('workspace:login', (_event, input) => workspaceLogin(input))
  appIpc.handle('workspace:logout', () => workspaceLogout())
  appIpc.handle('workspace:request', (_event, path, method, body) => workspaceRequest(path, method, body))
  appIpc.handle('workspace:attach', (_event, note, file) => workspaceAttach(note, file))
  appIpc.handle('team:chat', (_e, company, after, typing) => teamChat(company, after, typing))
  appIpc.handle('team:send', (_e, company, body, fileId) => teamSend(company, body, fileId))
  appIpc.handle('team:signal', (_e, company, kind) => teamSignal(company, kind))
  appIpc.handle('team:files', (_e, company) => teamFiles(company))
  appIpc.handle('team:file-change', (_e, company, id, change) => teamFileChange(company, id, change))
  appIpc.handle('team:upload', (_e, company, path, access, products, chat) => teamUpload(company, path, access, products, chat === true))
  appIpc.handle('team:image', (_e, company, id, name) => teamImage(company, id, name))
  appIpc.handle('team:open', async (_e, company, id, name, how) => { const path = await teamFetch(company, id, name); if (how === 'reveal') shell.showItemInFolder(path); else if (how === 'pane') queueOpenFile(path); else await shell.openPath(path) })
  // A chat message as a Mac notification; clicking it opens the chat. Returns false when macOS has them off.
  appIpc.handle('notify:permission', (_e, ask: unknown) => notifyPermission(ask === true))
  appIpc.handle('team:notify', async (_e, title: unknown, body: unknown) => {
    if (!Notification.isSupported() || !['authorized', 'provisional'].includes(await notifyPermission())) return false
    const n = new Notification({ title: String(title).slice(0, 120), body: String(body).slice(0, 300) })
    n.on('click', () => { if (!win || win.isDestroyed()) return; win.show(); win.focus(); win.webContents.send('teamchat:open') })
    n.show(); return true
  })
  // Reading each folder once makes macOS ask for it (Files and Folders); true where TerminAI may read it.
  appIpc.handle('app:ask-folders', async () => Object.fromEntries(await Promise.all(['Downloads', 'Documents', 'Desktop'].map(async name => {
    try { await readdir(join(homedir(), name)); return [name, true] } catch { return [name, false] } }))))
  appIpc.handle('bots:list', () => botList())
  appIpc.handle('bots:save', (_e, v) => botSave(v))
  appIpc.handle('bots:remove', (_e, id) => botRemove(id))
  appIpc.handle('bots:test', (_e, id) => botTest(id))
  appIpc.handle('app:notification-settings', () => shell.openExternal('x-apple.systempreferences:com.apple.Notifications-Settings.extension'))
  appIpc.handle('team:pick', async () => win ? (await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'] })).filePaths : [])
  appIpc.handle('workspace:pick-files', async () => win ? (await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'] })).filePaths : [])
  appIpc.handle('workspace:open-file', async (_event, note, fileId, name, reveal) => {
    const path = await workspaceFetchFile(note, fileId, name)
    if (reveal) shell.showItemInFolder(path); else queueOpenFile(path)
  })
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
  // Finder's right-click menu for an entry of the Files pane (or the folder itself when `background`). Actions that
  // need a name typed (rename, new file, new folder) come back to the pane; the rest happen here.
  appIpc.handle('project:menu', async (event, path: string, directory: boolean, background: boolean) => {
    const full = await projectFiles.resolved(path), name = basename(full), owner = BrowserWindow.fromWebContents(event.sender)
    const folder = directory ? path : dirname(path) === '.' ? '' : dirname(path)
    return new Promise<{ action: string; path?: string } | null>(resolve => {
      let chosen: { action: string; path?: string } | null = null
      const act = (work: () => unknown, after: (value: any) => { action: string; path?: string } | null = () => ({ action: 'refresh' })) => async () => {
        try { chosen = after(await work()) } catch (error) { chosen = { action: 'error', path: error instanceof Error ? error.message : String(error) } }
      }
      const done = (action: string, target = path) => () => { chosen = { action, path: target } }
      const items: Electron.MenuItemConstructorOptions[] = background ? [
        { label: 'New Folder', click: done('new-folder', path) }, { label: 'New File', click: done('new-file', path) },
        { type: 'separator' }, { label: 'Show in Finder', click: () => shell.showItemInFolder(full) },
        { label: 'Copy Path', click: () => clipboard.writeText(full) },
      ] : [
        { label: 'Open', click: done('open') },
        { label: 'Open With Default App', click: act(async () => { const error = await shell.openPath(full); if (error) throw new Error(error) }, () => null) },
        { type: 'separator' },
        { label: 'Move to Trash', click: act(() => shell.trashItem(full)) },
        { type: 'separator' },
        { label: 'Get Info', click: () => execFile('/usr/bin/osascript', ['-e', 'on run argv', '-e', 'tell application "Finder" to activate', '-e', 'tell application "Finder" to open information window of (POSIX file (item 1 of argv) as alias)', '-e', 'end run', full]) },
        { label: 'Rename…', click: done('rename') },
        { label: `Compress “${name}”`, click: act(() => projectFiles.compress(path)) },
        { label: 'Duplicate', click: act(() => projectFiles.duplicate(path)) },
        { label: 'Quick Look', enabled: !directory, click: () => owner?.previewFile(full) },
        { type: 'separator' },
        { label: `Copy “${name}”`, click: () => execFile('/usr/bin/osascript', ['-e', 'on run argv', '-e', 'set the clipboard to (POSIX file (item 1 of argv))', '-e', 'end run', full]) },  // pastes as the file in Finder, Mail…
        { label: 'Copy Path', click: () => clipboard.writeText(full) },
        { role: 'shareMenu', sharingItem: { filePaths: [full] } },
        { type: 'separator' },
        { label: 'Show in Finder', click: () => shell.showItemInFolder(full) },
        { label: 'New Folder', click: done('new-folder', folder) }, { label: 'New File', click: done('new-file', folder) },
      ]
      // A click runs before the menu reports closing; the async ones finish right after, so wait for them a moment.
      Menu.buildFromTemplate(items).popup({ window: owner ?? undefined, callback: () => setTimeout(() => resolve(chosen), 50) })
    })
  })
  appIpc.handle('project:rename', (_event, path: string, to: string) => projectFiles.renameEntry(path, to))
  appIpc.handle('project:create', (_event, folder: string, name: string, directory: boolean) => projectFiles.create(folder, name, directory))
  // The folder the Files pane shows, opened in Finder.
  appIpc.handle('project:openFolder', async (_event, path: string) => { const error = await shell.openPath(await projectFiles.resolved(typeof path === 'string' ? path : '')); if (error) throw new Error(error) })
  appIpc.handle('project:openExternal', async (_event, path: string) => { const error = await shell.openPath(await projectFiles.resolved(path)); if (error) throw new Error(error) })
  appIpc.handle('app:version', () => app.getVersion())
  appIpc.handle('memory:report', () => memoryReport())
  appIpc.handle('memory:sleep', (_e, ids: unknown) => sleepTabs(Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string') : []))
  appIpc.handle('memory:wake', (_e, id: unknown) => typeof id === 'string' ? resumeLater(id) || wakeTab(id) : false)
  appIpc.handle('memory:detail', () => memoryDetail())
  appIpc.handle('memory:process', (_e, pid: unknown) => processInfo(Number(pid)))
  appIpc.handle('memory:stop', (_e, pid: unknown, force: unknown) => Number.isInteger(pid) && Number(pid) > 1 ? stopProcess(Number(pid), force === true) : 'Not a process.')
  appIpc.handle('memory:storage', () => storageReport())
  // Feedback: an email to Maracuya Labs in the person's own mail app, with the version and Mac already filled in.
  // macOS keeps Downloads, Documents and Desktop behind a permission; this opens the page where TerminAI is allowed in.
  appIpc.handle('app:privacy-files', () => shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders'))
  // Feedback goes to TerminAI's server (we read it there); if the server cannot be reached, an email in Mail instead.
  appIpc.handle('app:feedback', async (_e, text: unknown, email: unknown) => {
    const body = `${typeof text === 'string' ? text.slice(0, 4000) : ''}\n\n—\nTerminAI ${app.getVersion()} · macOS ${process.getSystemVersion()} · ${process.arch}`
    const sent = await fetch(`${DEFAULT_WORKSPACE_URL}/api/feedback`, { method: 'POST', signal: AbortSignal.timeout(10000), headers: { 'Content-Type': 'application/json', 'X-TerminAI-Version': app.getVersion() },
      body: JSON.stringify({ message: body, email: typeof email === 'string' ? email : undefined }) }).then(r => r.ok).catch(() => false)
    if (sent) return 'sent'
    await shell.openExternal(`mailto:info@maracuyalabs.com?subject=${encodeURIComponent(`TerminAI feedback (${app.getVersion()})`)}&body=${encodeURIComponent(body)}`)
    return 'mail'
  })
  // macOS says memory is tight: name the tabs using most, before something is killed. A click opens Settings › Memory.
  watchMemory(r => {
    if (!Notification.isSupported()) return
    const tabName = (id: string) => { const t = store.load().tabs.find(x => x.ptyId === id); return t?.customTitle || t?.name || t?.title || basename(ptys.cwdOf(id)) || 'Session' }
    const top = r.tabs.slice(0, 3).map(t => `${tabName(t.id)} ${(t.mb / 1024).toFixed(1)} GB`).join(', ')
    const note = new Notification({ title: r.pressure === 'critical' ? 'Your Mac is out of memory' : 'Memory is getting tight', body: `Close a few sessions before apps get closed. Using most: ${top}.` })
    note.on('click', () => { if (!win || win.isDestroyed()) return; win.show(); win.focus(); win.webContents.send('settings:open', 'memory') })
    note.show()
  })
  appIpc.handle('app:check-updates', () => checkForUpdatesNow(win, true))
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
  appIpc.on('pty:exec', (_event, { id, cmd, resume }: {id: string; cmd: string; resume?: { continue?: boolean; later?: boolean }}) => {
    const line = String(cmd || '')
    // After a restart only the open tab and the ones that were working start at once; forty Claude Codes starting
    // together leave every tab blank for a long time. The others resume when they are opened (memory:wake).
    if (resume?.later && line) {
      laterResume.set(id, { line, carryOn: resume.continue === true })
      ptys.execWhenReady(id, `clear; printf '\\n  \\033[2mThis conversation resumes when you open the tab.\\033[0m\\n\\n'`)
      return
    }
    startAgent(id, line, resume ? { carryOn: resume.continue === true } : undefined)
  })
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
    remote: !store.load().teamTasks ? '' : process.env.TERMINAI_TASKS_REMOTE || (process.env.TERMINAI_TEST_BUILD ? '' : DEFAULT_TASKS_REMOTE),
    user: () => store.load().tasksUser,
    changed: todosChanged,
    listsChanged: writeGuides,
    server: workspaceTasks,
    // The other Mac's edits, pulled by a sync: one notice per sync, a click opens the To-do sheet.
    notify: ({ by, changed, removed, mentioned, requests, answered }) => {
      const name = by === 'ilai' ? 'Ilai' : 'Matteo', count = changed.length + removed.length
      // A request from the partner: its own notice, answered from the notice (Accept, or Reply to add a message).
      for (const t of requests ?? []) {
        if (win && !win.isDestroyed()) win.webContents.send('todos:notice', { text: `${name} asks${t.request?.urgent ? ' (urgent)' : ''}: ${t.title}`, mention: true })
        if (!Notification.isSupported()) continue
        const n = new Notification({ title: `${t.request?.urgent ? 'Urgent request' : 'Request'} from ${name}`, body: t.title + (t.notes ? `\n${t.notes.slice(0, 140)}` : ''),
          actions: [{ type: 'button', text: 'Accept' }, { type: 'button', text: 'Decline' }], hasReply: true, replyPlaceholder: 'Accept with a message', closeButtonText: 'Later' })
        n.on('action', (_e, i) => void todos.answer(t.id, i === 0).catch(() => {}))
        n.on('reply', (_e, reply) => void todos.answer(t.id, true, reply).catch(() => {}))
        n.on('click', () => { if (!win || win.isDestroyed()) return; win.show(); win.webContents.send('todos:open') })
        n.show()
      }
      for (const t of answered ?? []) {
        if (!Notification.isSupported()) continue
        const ok = t.request?.status === 'accepted'
        new Notification({ title: `${name} ${ok ? 'accepted' : 'declined'} your request`, body: `${t.title}${t.request?.reply ? `\n“${t.request.reply}”` : ''}` }).show()
      }
      if ((requests?.length || answered?.length) && count === (requests?.length ?? 0) + (answered?.length ?? 0)) return
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
  appIpc.handle('todos:answer', async (_e, id: unknown, accept: unknown, reply: unknown) => { await todos.answer(id, accept === true, reply); return todos.list() })
  appIpc.handle('todos:request', async (_e, title: unknown, note: unknown, urgent: unknown) => { await todos.request(title, note, urgent === true); return todos.list() })
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
  // ---- the bridge: tabs as shared conversations, agents messaging each other's sessions
  const tabName = (id: string) => { const tab = store.load().tabs.find(t => t.ptyId === id); return tab?.customTitle || tab?.name || tab?.title || basename(ptys.cwdOf(id)) || 'Session' }
  bridge = createBridge({
    team: async () => { const user = store.load().tasksUser; return user && !process.env.TERMINAI_TEST_BUILD ? teamOf(user) : null },
    tabName,
    wake: (tabId: string) => resumeLater(tabId) || wakeTab(tabId),
    waiting: (tabId: string) => laterResume.has(tabId),
    approve: async (from, tab, text, tabId, force) => {
      // A bot set to ask every time (or asking something risky) asks even when messages are set to Allow.
      if (!win || win.isDestroyed()) return !force
      if (store.load().agentMessages === 'allow' && !force) return true
      win.webContents.send('tab:request', { reqId: `ask-${Date.now()}`, kind: 'focus', input: { id: tabId } })
      const { response } = await dialog.showMessageBox(win, { type: 'question', buttons: force ? ['Allow', 'Decline'] : ['Allow', 'Decline', 'Always allow'], defaultId: 0, cancelId: 1,
        message: `${from} wants to message “${tab}”`, detail: (text.length > 600 ? text.slice(0, 597) + '…' : text) + (force ? '\n\nThis bot is set to ask before its messages reach your sessions.' : '') })
      if (response === 2 && !force) store.save({ ...store.load(), agentMessages: 'allow' })
      return response !== 1
    },
    notify: (title, body, tabId) => {
      if (!Notification.isSupported()) return
      const note = new Notification({ title, body, silent: true })
      note.on('click', () => { if (!win || win.isDestroyed()) return; win.show(); win.focus(); win.webContents.send('tab:request', { reqId: `notice-${Date.now()}`, kind: 'focus', input: { id: tabId } }) })
      note.show()
      // The tab gets the partner's outline in the sidebar until it is opened.
      const from = /^(?:Reply from )?(.+?)'s agent/.exec(title)?.[1]
      if (from && win && !win.isDestroyed()) win.webContents.send('team:incoming', { tabId, from })
    },
  })
  bridge.start()
  appIpc.handle('team:agentMessages', (_e, v: unknown) => { if (v === 'ask' || v === 'allow') store.save({ ...store.load(), agentMessages: v }); return store.load().agentMessages })
  appIpc.handle('team:tabs', () => { const p = store.load(); return { agentMessages: p.agentMessages, byDefault: p.shareConversations, tabs: ptys.liveIds().filter(id => ptys.agentOf(id).kind).map(id => { const key = ptys.workspaceKeyOf(id); return { key, name: tabName(id), shared: tabMode(key, ptys.cwdOf(id)) === 'shared', mode: tabMode(key, ptys.cwdOf(id)) } }), folders: p.folderSharing } })
  appIpc.handle('team:folder', async (_e, folder: unknown, mode: unknown) => {
    const p = store.load(), rules = { ...p.folderSharing }
    let path = typeof folder === 'string' ? folder : ''
    if (folder === null || folder === 'git:') {
      const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory'], defaultPath: homedir(), message: folder ? 'Choose a folder of the git repo: the rule covers every clone and worktree of it' : 'Choose a folder to set what Matteo may see of its conversations' })
      if (r.canceled || !r.filePaths[0]) return p.folderSharing
      path = r.filePaths[0]
      if (folder === 'git:') { const repo = repoOf(path); if (!repo) throw new Error('That folder is not in a git repo with a remote.'); path = `git:${repo}` }
    }
    if (!path || path.length > 1000) throw new Error('Invalid folder')
    if (mode === null) delete rules[path]; else if (mode === 'shared' || mode === 'private' || mode === 'off') rules[path] = mode; else throw new Error('Invalid mode')
    store.save({ ...p, folderSharing: rules }); void bridge?.tick(); return rules
  })
  appIpc.handle('team:share', (_e, key: unknown, shared: unknown) => {
    if (typeof shared !== 'boolean') throw new Error('Invalid')
    const p = store.load()
    if (key === null) store.save({ ...p, shareConversations: shared })
    else if (typeof key === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(key)) store.save({ ...p, tabSharing: { ...p.tabSharing, [key]: shared } })
    else throw new Error('Invalid')
    void bridge?.tick()
  })
  // ---- work log: this person's day, sent to the workspace every 10 minutes (yesterday once, it may run past midnight)
  const logDay = async (day: string) => {
    const user = store.load().tasksUser
    if (!user || process.env.TERMINAI_TEST_BUILD) return
    const p = store.load()
    await workspaceWorklog.put(user, day, workDay(day, user, p.worklogSkip, defaultMode)).catch(err => console.warn('[worklog]', err?.message ?? err))
  }
  setTimeout(() => { void logDay(today(new Date(Date.now() - 86400_000))).then(() => logDay(today())) }, 20_000)
  setInterval(() => void logDay(today()), 10 * 60_000)
  appIpc.handle('worklog:get', async (_e, day: unknown) => {
    if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('Invalid day')
    const user = store.load().tasksUser, mine = user ? workDay(day, user, store.load().worklogSkip) : null
    // Your own day is read here, always current; the partner's comes from the workspace.
    const people = user ? await workspaceWorklog.get(user, day).catch(() => null) : null
    return { day, people: { ...(people ?? {}), ...(mine && user ? { [user]: mine } : {}) }, offline: people === null }
  })
  setInterval(() => void todos.sync(), 60_000)   // a minute: edits from the phone come in through here

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
