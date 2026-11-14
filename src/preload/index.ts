type Notice = { id: string; kind: 'done' | 'todo' | 'request' | 'chat' | 'agent' | 'memory' | 'update'; title: string; body: string; at: string; read: boolean; target?: { tab?: string; open?: 'todos' | 'activity' | 'chat' | 'memory' | 'updates' } }
type BotInfo = { id: string; name: string; keyId?: string; host: string; agent: string; isDefault: boolean; status: { ok: boolean; at: string; error?: string } | null }
type GuardState = { running: boolean; level: number; paused: { id: string; name: string; at: string }[]; off?: { until: number | null } }
import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import type { ProjectListing, ProjectPreview } from '../shared/project-files'
import type { WorkspaceState, WorkspaceLogin, McpSetupResult } from '../shared/workspace'
import type { BrowserState } from '../shared/browser'
import type { AccountFlow, ChromeProfile, ClaudeAccounts, Prefs, TabStatus, Task, TaskInput, TaskActivity, TaskList, TaskScope, TaskVersion, VoiceClip } from '../shared/types'
import type { QuestionKind } from '../shared/questions'

/**
 * The only surface the renderer gets. contextIsolation is on and nodeIntegration
 * is off, so terminal output can never reach a Node API even if something in it
 * is hostile.
 */
const api = {
  app: { launch: (): Promise<{crashed: boolean}> => ipcRenderer.invoke('app:launch') },
  window: {
    fullscreen: (): Promise<boolean> => ipcRenderer.invoke('window:fullscreen'),
    onFullscreen: (cb: (value: boolean) => void): (() => void) => { const handler = (_event: Electron.IpcRendererEvent, value: boolean) => cb(value); ipcRenderer.on('window:fullscreen', handler); return () => { ipcRenderer.removeListener('window:fullscreen', handler) } },
    toggleMaximize: (): Promise<void> => ipcRenderer.invoke('window:toggle-maximize'),
    version: (): Promise<string> => ipcRenderer.invoke('app:version'),
    feedback: (text: string, email?: string): Promise<'sent' | 'mail'> => ipcRenderer.invoke('app:feedback', text, email),
    memory: (): Promise<import('../main/memory').MemoryReport> => ipcRenderer.invoke('memory:report'),
    wake: (id: string): Promise<boolean> => ipcRenderer.invoke('memory:wake', id),
    memoryDetail: (): Promise<import('../main/memoryDetail').MemoryDetail> => ipcRenderer.invoke('memory:detail'),
    processInfo: (pid: number): Promise<import('../main/memoryDetail').ProcInfo> => ipcRenderer.invoke('memory:process', pid),
    stopProcess: (pid: number, force: boolean): Promise<string> => ipcRenderer.invoke('memory:stop', pid, force),
    storage: (): Promise<import('../main/memoryDetail').StorageReport> => ipcRenderer.invoke('memory:storage'),
    onOpenSettings: (cb: (section?: string) => void): (() => void) => { const h = (_e: IpcRendererEvent, section?: string) => cb(section); ipcRenderer.on('settings:open', h); return () => { ipcRenderer.removeListener('settings:open', h) } },
    checkForUpdates: (): Promise<string> => ipcRenderer.invoke('app:check-updates') },
  team: {
    agentMessages: (v?: 'ask' | 'allow'): Promise<'ask' | 'allow'> => ipcRenderer.invoke('team:agentMessages', v),
    onIncoming: (cb: (v: { tabId: string; from: string }) => void): (() => void) => { const h = (_e: Electron.IpcRendererEvent, v: { tabId: string; from: string }) => cb(v); ipcRenderer.on('team:incoming', h); return () => { ipcRenderer.removeListener('team:incoming', h) } }, tabs: (): Promise<{ agentMessages: 'ask' | 'allow'; byDefault: boolean; tabs: { key: string; name: string; shared: boolean; mode: string; own?: boolean; rule?: string }[]; folders: Record<string, string> }> => ipcRenderer.invoke('team:tabs'), tabMode: (key: string, mode: 'shared' | 'private' | 'off' | null): Promise<void> => ipcRenderer.invoke('team:tabMode', key, mode), share: (key: string | null, shared: boolean): Promise<void> => ipcRenderer.invoke('team:share', key, shared),
    folder: (folder: string | null, mode: 'shared' | 'private' | 'off' | null): Promise<Record<string, string>> => ipcRenderer.invoke('team:folder', folder, mode) },
  macguard: {
    state: (): Promise<GuardState | null> => ipcRenderer.invoke('macguard:state'),
    resume: (ids: string[]): Promise<GuardState | null> => ipcRenderer.invoke('macguard:resume', ids),
    details: (): Promise<(GuardState & { at: string; sample: Record<string, number>; limits: Record<string, number>; events: { at: string; text: string }[]; sessions: number }) | null> => ipcRenderer.invoke('macguard:details'),
    restart: (): Promise<void> => ipcRenderer.invoke('macguard:restart'),
    pause: (minutes: number | null): Promise<GuardState | null> => ipcRenderer.invoke('macguard:pause', minutes),
    unpause: (): Promise<GuardState | null> => ipcRenderer.invoke('macguard:unpause'),
    onState: (cb: (s: GuardState | null) => void): (() => void) => { const h = (_e: Electron.IpcRendererEvent, s: GuardState | null) => cb(s); ipcRenderer.on('macguard:state', h); return () => { ipcRenderer.removeListener('macguard:state', h) } } },
  worklog: { get: (day: string): Promise<{ day: string; me?: string; names?: Record<string, string>; people: Record<string, import('../shared/types').WorkDay>; offline: boolean }> => ipcRenderer.invoke('worklog:get', day) },
  workspace: {
    onSignedIn: (cb: () => void): (() => void) => { const h = () => cb(); ipcRenderer.on('workspace:signed-in', h); return () => { ipcRenderer.removeListener('workspace:signed-in', h) } },
    openManager: (): Promise<void> => ipcRenderer.invoke('workspace:open-manager'),
    state: (): Promise<WorkspaceState> => ipcRenderer.invoke('workspace:state'),
    hasAccount: (): Promise<boolean> => ipcRenderer.invoke('workspace:has-account'),
    browserLoginStart: (url: string): Promise<{ code: string }> => ipcRenderer.invoke('workspace:browser-login-start', url),
    browserLoginWait: (): Promise<WorkspaceState> => ipcRenderer.invoke('workspace:browser-login-wait'),
    browserLoginCancel: (): Promise<void> => ipcRenderer.invoke('workspace:browser-login-cancel'),
    login: (input: WorkspaceLogin): Promise<WorkspaceState> => ipcRenderer.invoke('workspace:login', input),
    logout: (): Promise<void> => ipcRenderer.invoke('workspace:logout'),
    request: (path: string, method = 'GET', body?: unknown): Promise<any> => ipcRenderer.invoke('workspace:request', path, method, body),
    attach: (note: string, file: string): Promise<any> => ipcRenderer.invoke('workspace:attach', note, file),
    pickFiles: (): Promise<string[]> => ipcRenderer.invoke('workspace:pick-files'),
    openFile: (note: string, fileId: string, name: string, reveal = false): Promise<void> => ipcRenderer.invoke('workspace:open-file', note, fileId, name, reveal),
    setupTools: (companyId: string): Promise<McpSetupResult[]> => ipcRenderer.invoke('workspace:setup-tools', companyId),
  },
  project: {
    pending: (): Promise<string | null> => ipcRenderer.invoke('project:pending'),
    open: (id: string): Promise<{listing: ProjectListing; preview: ProjectPreview}> => ipcRenderer.invoke('project:open', id),
    onOpen: (cb: (id: string) => void): (() => void) => { const handler=(_e:IpcRendererEvent,id:string)=>cb(id); ipcRenderer.on('project:open-request',handler); return ()=>{ipcRenderer.removeListener('project:open-request',handler)} },
    choose: (): Promise<string | null> => ipcRenderer.invoke('project:choose'),
    list: (path: string): Promise<ProjectListing> => ipcRenderer.invoke('project:list', path),
    save: (path: string, content: string, version: string): Promise<ProjectPreview> => ipcRenderer.invoke('project:save', path, content, version),
    preview: (path: string): Promise<ProjectPreview> => ipcRenderer.invoke('project:preview', path),
    privacy: (): Promise<void> => ipcRenderer.invoke('app:privacy-files'),
    openFolder: (path: string): Promise<void> => ipcRenderer.invoke('project:openFolder', path),
    openExternal: (path: string): Promise<void> => ipcRenderer.invoke('project:openExternal', path),
    reveal: (path: string): Promise<string> => ipcRenderer.invoke('project:reveal', path),
    menu: (path: string, directory: boolean, background = false): Promise<{ action: string; path?: string } | null> => ipcRenderer.invoke('project:menu', path, directory, background),
    rename: (path: string, to: string): Promise<string> => ipcRenderer.invoke('project:rename', path, to),
    create: (folder: string, name: string, directory: boolean): Promise<string> => ipcRenderer.invoke('project:create', folder, name, directory),
  },
  browser: {
    state: (): Promise<BrowserState> => ipcRenderer.invoke('browser:state'),
    action: (type: string, input: Record<string, unknown> = {}): Promise<any> => ipcRenderer.invoke('browser:action', type, input),
    onReveal: (cb: () => void): (() => void) => { ipcRenderer.on('browser:reveal', cb); return () => { ipcRenderer.removeListener('browser:reveal', cb) } },
    navigate: (url: string): Promise<void> => ipcRenderer.invoke('browser:navigate', url),
    command: (action: 'back' | 'forward' | 'reload' | 'external'): Promise<void> => ipcRenderer.invoke('browser:command', action),
    layout: (bounds: {x: number; y: number; width: number; height: number; visible: boolean}): Promise<void> => ipcRenderer.invoke('browser:layout', bounds),
    onState: (cb: (state: BrowserState) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, state: BrowserState) => cb(state)
      ipcRenderer.on('browser:state', handler)
      return () => ipcRenderer.removeListener('browser:state', handler)
    },
  },
  pty: {
    /** Pause a chat by hand (true) or resume it (false); returns every tab paused this way: id -> HH:MM. */
    pause: (id: string, on: boolean): Promise<Record<string, string>> => ipcRenderer.invoke('tab:pause', id, on),
    paused: (): Promise<Record<string, string>> => ipcRenderer.invoke('tab:paused'),
    onPaused: (cb: (p: Record<string, string>) => void) => { const h = (_e: unknown, p: Record<string, string>) => cb(p); ipcRenderer.on('tab:paused', h); return () => { ipcRenderer.removeListener('tab:paused', h) } },
    /** The right-click menu of a chat in the sidebar: resolves with the action picked (pause, resume, rename, hide, close) or null. */
    menu: (id: string, hidden: boolean, cloud = false): Promise<string | null> => ipcRenderer.invoke('tab:menu', id, hidden, cloud),
    /** A cloud session spotted in a tab's output. */
    onCloud: (cb: (e: { tabId: string; cloud: { id: string; url: string; title?: string } }) => void) => { const h = (_e: unknown, v: { tabId: string; cloud: { id: string; url: string; title?: string } }) => cb(v); ipcRenderer.on('tab:cloud', h); return () => { ipcRenderer.removeListener('tab:cloud', h) } },
    cloudAction: (tabId: string, action: 'open' | 'message' | 'teleport', sessionId: string): Promise<boolean> => ipcRenderer.invoke('tab:cloud-action', tabId, action, sessionId),
    close: (id: string): void => ipcRenderer.send('pty:close', { id }),
    unclose: (id: string): Promise<{id: string; cwd: string; exited: boolean} | null> => ipcRenderer.invoke('pty:unclose', { id }),
    agent: (id: string): Promise<{kind: '' | 'claude' | 'codex'; sessionId: string; args: string[]; alive: boolean}> => ipcRenderer.invoke('pty:agent', { id }),
    resumeCommand: (desc: {kind: string; sessionId?: string; args?: string[]; cwd?: string; fresh?: boolean}): Promise<string> => ipcRenderer.invoke('pty:resumeCommand', desc),
    exec: (id: string, cmd: string, resume?: { continue?: boolean; later?: boolean }): void => ipcRenderer.send('pty:exec', { id, cmd, resume }),
    size: (id: string): Promise<{ cols: number; rows: number } | null> => ipcRenderer.invoke('pty:size', { id }),
    create: (opts: { cwd?: string; cols?: number; rows?: number; browserKey?: string }): Promise<{ id: string; cwd: string }> =>
      ipcRenderer.invoke('pty:create', opts),
    list: (): Promise<{ id: string; cwd: string; exited: boolean }[]> =>
      ipcRenderer.invoke('pty:list'),
    attach: (id: string): Promise<boolean> => ipcRenderer.invoke('pty:attach', { id }),
    write: (id: string, data: string): void => ipcRenderer.send('pty:write', { id, data }),
    resize: (id: string, cols: number, rows: number): void =>
      ipcRenderer.send('pty:resize', { id, cols, rows }),
    kill: (id: string): void => ipcRenderer.send('pty:kill', { id }),
    process: (id: string): Promise<string> => ipcRenderer.invoke('pty:process', { id }),
    status: (id: string): Promise<TabStatus> => ipcRenderer.invoke('pty:status', { id }),
    setQuestion: (id: string, kind: QuestionKind | null): void => ipcRenderer.send('pty:question', { id, kind }),
    usedClaude: (id: string): Promise<boolean> => ipcRenderer.invoke('pty:usedClaude', { id }),
    cwd: (id: string): Promise<string> => ipcRenderer.invoke('pty:cwd', { id }),
    claudeSession: (id: string): Promise<string> => ipcRenderer.invoke('pty:claudeSession', { id }),
    recentSessions: (cwd: string, limit: number): Promise<string[]> =>
      ipcRenderer.invoke('pty:recentSessions', { cwd, limit }),
    canResume: (sessionId: string): Promise<boolean> =>
      ipcRenderer.invoke('pty:canResume', { sessionId }),

    onData: (cb: (id: string, data: string) => void): (() => void) => {
      const h = (_e: IpcRendererEvent, p: { id: string; data: string }): void => cb(p.id, p.data)
      ipcRenderer.on('pty:data', h)
      return () => ipcRenderer.removeListener('pty:data', h)
    },
    onExit: (cb: (id: string, code: number) => void): (() => void) => {
      const h = (_e: IpcRendererEvent, p: { id: string; exitCode: number }): void =>
        cb(p.id, p.exitCode)
      ipcRenderer.on('pty:exit', h)
      return () => ipcRenderer.removeListener('pty:exit', h)
    },
  },

  tabs: {
    setActive: (id: string | null): void => ipcRenderer.send('tab:active', { id }),
    /** Requests from the local control channel (src/main/control.ts); the answer goes back under the same reqId. */
    onRequest: (cb: (kind: string, input: any) => unknown): (() => void) => {
      const h = (_e: IpcRendererEvent, p: { reqId: string; kind: string; input: any }): void => {
        let result: unknown = null
        try {
          result = cb(p.kind, p.input)
        } catch {
          /* answered as null */
        }
        ipcRenderer.send('tab:reply', { reqId: p.reqId, result })
      }
      ipcRenderer.on('tab:request', h)
      return () => ipcRenderer.removeListener('tab:request', h)
    },
  },

  /** Personal and shared to-dos; src/main/todos.ts does the files and the git sync. */
  notices: {
    list: (): Promise<Notice[]> => ipcRenderer.invoke('notices:list'),
    read: (ids: string[] | 'all'): Promise<Notice[]> => ipcRenderer.invoke('notices:read', ids),
    clear: (): Promise<Notice[]> => ipcRenderer.invoke('notices:clear'),
    onNew: (cb: (n: Notice) => void): (() => void) => { const h = (_e: IpcRendererEvent, n: Notice) => cb(n); ipcRenderer.on('notices:new', h); return () => { ipcRenderer.removeListener('notices:new', h) } },
  },
  agents: {
    status: (): Promise<{ claude: boolean; codex: boolean; chrome: boolean; chromeApp: boolean }> => ipcRenderer.invoke('agents:status'),
    install: (which: ('claude' | 'codex' | 'chrome')[]): Promise<boolean> => ipcRenderer.invoke('agents:install', which),
  },
  teamchat: {
    /** Sharing the screen needs macOS Screen Recording permission: called when it is missing (Settings was opened). */
    onScreenPermission: (cb: () => void) => { const h = () => cb(); ipcRenderer.on('screen:permission', h); return () => { ipcRenderer.removeListener('screen:permission', h) } },
    chat: (company: string, after?: string, typing?: string, pending?: string, channel?: string): Promise<any> => ipcRenderer.invoke('team:chat', company, after, typing, pending, channel),
    channels: (company: string): Promise<{ team: boolean; channels: string[]; latest?: Record<string, { at: string; from: string; fromName: string; body: string }>; dms?: { channel: string; id: string; name: string }[]; me?: string }> => ipcRenderer.invoke('team:channels', company),
    send: (company: string, body: string, fileId?: string, channel?: string): Promise<any> => ipcRenderer.invoke('team:send', company, body, fileId, channel),
    signal: (company: string, kind: 'typing' | 'read'): Promise<void> => ipcRenderer.invoke('team:signal', company, kind),
    call: (company: string, after?: string): Promise<any> => ipcRenderer.invoke('team:call', company, after),
    callSend: (company: string, signal: object): Promise<any> => ipcRenderer.invoke('team:call-send', company, signal),
    ice: (company: string): Promise<{ iceServers: RTCIceServer[] }> => ipcRenderer.invoke('team:ice', company),
    mediaAccess: (video: boolean): Promise<boolean> => ipcRenderer.invoke('team:media-access', video),
    callNotify: (title: string, body: string): Promise<boolean> => ipcRenderer.invoke('team:call-notify', title, body),
    files: (company: string): Promise<any> => ipcRenderer.invoke('team:files', company),
    change: (company: string, id: string, change: object | null): Promise<any> => ipcRenderer.invoke('team:file-change', company, id, change),
    share: (company: string, id: string, on: boolean): Promise<{ url?: string; ok?: boolean }> => ipcRenderer.invoke('team:file-share', company, id, on),
    upload: (company: string, path: string, access = 'all', products: string[] = [], chat = false, folder = ''): Promise<any> => ipcRenderer.invoke('team:upload', company, path, access, products, chat, folder),
    image: (company: string, id: string, name: string): Promise<string> => ipcRenderer.invoke('team:image', company, id, name),
    open: (company: string, id: string, name: string, how: 'app' | 'pane' | 'reveal' = 'app'): Promise<void> => ipcRenderer.invoke('team:open', company, id, name, how),
    fetch: (company: string, id: string, name: string): Promise<string> => ipcRenderer.invoke('team:fetch', company, id, name),
    pick: (): Promise<string[]> => ipcRenderer.invoke('team:pick'),
    notify: (title: string, body: string): Promise<boolean> => ipcRenderer.invoke('team:notify', title, body),
    notificationSettings: (): Promise<void> => ipcRenderer.invoke('app:notification-settings'),
    askFolders: (): Promise<Record<string, boolean>> => ipcRenderer.invoke('app:ask-folders'),
    notifyPermission: (ask = false): Promise<string> => ipcRenderer.invoke('notify:permission', ask),
    bots: (): Promise<BotInfo[]> => ipcRenderer.invoke('bots:list'),
    botSave: (v: object): Promise<BotInfo[]> => ipcRenderer.invoke('bots:save', v),
    botRemove: (id: string): Promise<BotInfo[]> => ipcRenderer.invoke('bots:remove', id),
    botTest: (id: string): Promise<BotInfo[]> => ipcRenderer.invoke('bots:test', id),
    onOpen: (cb: () => void): (() => void) => { const h = () => cb(); ipcRenderer.on('teamchat:open', h); return () => { ipcRenderer.removeListener('teamchat:open', h) } },
    pathOf: (file: File): string => webUtils.getPathForFile(file),
  },
  todos: {
    list: (): Promise<TaskList> => ipcRenderer.invoke('todos:list'),
    answer: (id: string, accept: boolean, reply?: string): Promise<TaskList> => ipcRenderer.invoke('todos:answer', id, accept, reply),
    request: (title: string, note: string, urgent: boolean): Promise<TaskList> => ipcRenderer.invoke('todos:request', title, note, urgent),
    save: (scope: TaskScope, input: TaskInput): Promise<TaskList> => ipcRenderer.invoke('todos:save', scope, input),
    /** Several at once: one commit for the shared ones. */
    saveMany: (scope: TaskScope, inputs: TaskInput[]): Promise<TaskList> => ipcRenderer.invoke('todos:saveMany', scope, inputs),
    remove: (scope: TaskScope, id: string): Promise<TaskList> => ipcRenderer.invoke('todos:remove', scope, id),
    removeMany: (scope: TaskScope, ids: string[]): Promise<TaskList> => ipcRenderer.invoke('todos:removeMany', scope, ids),
    /** Undo: the tasks written back exactly as given (id, dates, authors). */
    restore: (scope: TaskScope, tasks: Task[]): Promise<TaskList> => ipcRenderer.invoke('todos:restore', scope, tasks),
    /** Private ⇄ shared; to shared it goes to `assignee`, by default the user. `order` places it in the list it goes to. */
    move: (from: TaskScope, id: string, assignee?: Task['assignee'], order?: number, into?: string): Promise<TaskList> => ipcRenderer.invoke('todos:move', from, id, assignee, order, into),
    /** Private lists, the pages of the private view; a removed one comes back with restoreList for a day. */
    addList: (name: string): Promise<TaskList> => ipcRenderer.invoke('todos:addList', name),
    renameList: (id: string, name: string): Promise<TaskList> => ipcRenderer.invoke('todos:renameList', id, name),
    removeList: (id: string): Promise<TaskList> => ipcRenderer.invoke('todos:removeList', id),
    restoreList: (id: string): Promise<TaskList> => ipcRenderer.invoke('todos:restoreList', id),
    describeList: (id: string, about: string): Promise<TaskList> => ipcRenderer.invoke('todos:describeList', id, about),
    sync: (): Promise<TaskList> => ipcRenderer.invoke('todos:sync'),
    /** The shared tasks the user has now looked at, so their "edited by" mark goes. */
    markSeen: (ids: string[]): Promise<TaskList> => ipcRenderer.invoke('todos:markSeen', ids),
    history: (id: string): Promise<TaskVersion[]> => ipcRenderer.invoke('todos:history', id),
    activity: (): Promise<TaskActivity[]> => ipcRenderer.invoke('todos:activity'),
    /** A sync brought the other person's changes in: the line for the in-app notice. */
    onNotice: (cb: (notice: { text: string; mention: boolean }) => void): (() => void) => { const on = (_e: unknown, notice: { text: string; mention: boolean }) => cb(notice); ipcRenderer.on('todos:notice', on); return () => { ipcRenderer.removeListener('todos:notice', on) } },
    /** Images under a task's note: bytes from a paste or a drop, or picked in a file dialog. */
    addImage: (scope: TaskScope, id: string, bytes: ArrayBuffer): Promise<TaskList> => ipcRenderer.invoke('todos:addImage', scope, id, new Uint8Array(bytes)),
    pickImages: (scope: TaskScope, id: string): Promise<TaskList> => ipcRenderer.invoke('todos:pickImages', scope, id),
    removeImage: (scope: TaskScope, id: string, name: string): Promise<TaskList> => ipcRenderer.invoke('todos:removeImage', scope, id, name),
    imageThumb: (scope: TaskScope, id: string, name: string): Promise<string> => ipcRenderer.invoke('todos:imageThumb', scope, id, name),
    imageFull: (scope: TaskScope, id: string, name: string): Promise<string> => ipcRenderer.invoke('todos:imageFull', scope, id, name),
    showImage: (scope: TaskScope, id: string, name: string): Promise<void> => ipcRenderer.invoke('todos:showImage', scope, id, name),
    onOpen: (cb: () => void): (() => void) => { ipcRenderer.on('todos:open', cb); return () => { ipcRenderer.removeListener('todos:open', cb) } },
    onChanged: (cb: () => void): (() => void) => { ipcRenderer.on('todos:changed', cb); return () => { ipcRenderer.removeListener('todos:changed', cb) } },
  },

  /** Plays one kind of notification's sound now, whatever Settings says (the preview in Settings › Notifications). */
  sound: { test: (kind: string, name?: string): Promise<boolean> => ipcRenderer.invoke('sound:test', kind, name) },
  prefs: {
    get: (): Promise<Prefs> => ipcRenderer.invoke('prefs:get'),
    set: (patch: Partial<Prefs>): Promise<Prefs> => ipcRenderer.invoke('prefs:set', patch),
  },

  voice: {
    speak: (text: string): Promise<VoiceClip> => ipcRenderer.invoke('voice:speak', { text }),
    voices: (): Promise<string[]> => ipcRenderer.invoke('voice:voices'),
    hasElevenKey: (): Promise<boolean> => ipcRenderer.invoke('voice:hasElevenKey'),
    hasLocal: (): Promise<boolean> => ipcRenderer.invoke('voice:hasLocal'),
    elevenVoices: (): Promise<
      | { ok: true; voices: { id: string; name: string; category: string; description: string }[] }
      | { ok: false; error: string }
    > => ipcRenderer.invoke('voice:elevenVoices'),
    setElevenKey: (key: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('voice:setElevenKey', { key }),
    save: (path: string, text: string): Promise<{ saved: boolean; filePath?: string }> =>
      ipcRenderer.invoke('voice:save', { path, text }),

    onClip: (cb: (clip: VoiceClip) => void): (() => void) => {
      const h = (_e: IpcRendererEvent, clip: VoiceClip): void => cb(clip)
      ipcRenderer.on('voice:clip', h)
      return () => ipcRenderer.removeListener('voice:clip', h)
    },
    onError: (cb: (message: string) => void): (() => void) => {
      const h = (_e: IpcRendererEvent, p: { message: string }): void => cb(p.message)
      ipcRenderer.on('voice:error', h)
      return () => ipcRenderer.removeListener('voice:error', h)
    },
  },

  /** Claude accounts per tab; src/main/accounts.ts keeps the tokens in the keychain, never here. */
  accounts: {
    list: (): Promise<ClaudeAccounts> => ipcRenderer.invoke('accounts:list'),
    forTab: (ptyId: string): Promise<string> => ipcRenderer.invoke('accounts:forTab', ptyId),
    use: (ptyId: string, id: string): Promise<void> => ipcRenderer.invoke('accounts:use', ptyId, id),
    setMode: (mode: ClaudeAccounts['mode']): Promise<void> => ipcRenderer.invoke('accounts:mode', mode),
    setDefault: (id: string): Promise<void> => ipcRenderer.invoke('accounts:default', id),
    add: (label: string): Promise<AccountFlow> => ipcRenderer.invoke('accounts:add', label),
    openInChrome: (flowId: string, profileDir: string): Promise<void> => ipcRenderer.invoke('accounts:open', flowId, profileDir),
    cancel: (flowId: string): Promise<void> => ipcRenderer.invoke('accounts:cancel', flowId),
    remove: (id: string): Promise<void> => ipcRenderer.invoke('accounts:remove', id),
    rename: (id: string, label: string): Promise<void> => ipcRenderer.invoke('accounts:rename', id, label),
    chromeProfiles: (): Promise<ChromeProfile[]> => ipcRenderer.invoke('accounts:chromeProfiles'),
    refreshUsage: (): Promise<void> => ipcRenderer.invoke('accounts:refreshUsage'),
    onChanged: (cb: () => void): (() => void) => { ipcRenderer.on('accounts:changed', cb); return () => { ipcRenderer.removeListener('accounts:changed', cb) } },
    onFlow: (cb: (flow: AccountFlow) => void): (() => void) => { const handler = (_e: IpcRendererEvent, flow: AccountFlow) => cb(flow); ipcRenderer.on('accounts:flow', handler); return () => { ipcRenderer.removeListener('accounts:flow', handler) } },
  },

  design: {
    repo: (): Promise<{ path: string; exists: boolean }> => ipcRenderer.invoke('design:repo'),
  },

  dialog: {
    pickFolder: (): Promise<string | null> => ipcRenderer.invoke('dialog:pickFolder'),
  },

  files: {
    stageImage: (path: string): Promise<boolean> => ipcRenderer.invoke('clip:image', path),
    /**
     * Electron 32 removed `File.path`, so a dropped file's real location is only
     * reachable through webUtils — which lives on this side of the bridge.
     * Returns '' for anything that is not a real on-disk file.
     */
    pathFor: (file: File): string => {
      try {
        return webUtils.getPathForFile(file)
      } catch {
        return ''
      }
    },
  },
}

contextBridge.exposeInMainWorld('term', api)

export type TermApi = typeof api
