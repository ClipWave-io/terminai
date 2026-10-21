import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import type { ProjectListing, ProjectPreview } from '../shared/project-files'
import type { WorkspaceState, WorkspaceLogin, McpSetupResult } from '../shared/workspace'
import type { BrowserState } from '../shared/browser'
import type { AccountFlow, ChromeProfile, ClaudeAccounts, Prefs, TabStatus, Task, TaskInput, TaskList, TaskScope, VoiceClip } from '../shared/types'

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
    toggleMaximize: (): Promise<void> => ipcRenderer.invoke('window:toggle-maximize') },
  workspace: {
    openManager: (): Promise<void> => ipcRenderer.invoke('workspace:open-manager'),
    state: (): Promise<WorkspaceState> => ipcRenderer.invoke('workspace:state'),
    login: (input: WorkspaceLogin): Promise<WorkspaceState> => ipcRenderer.invoke('workspace:login', input),
    logout: (): Promise<void> => ipcRenderer.invoke('workspace:logout'),
    request: (path: string, method = 'GET', body?: unknown): Promise<any> => ipcRenderer.invoke('workspace:request', path, method, body),
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
    close: (id: string): void => ipcRenderer.send('pty:close', { id }),
    unclose: (id: string): Promise<{id: string; cwd: string; exited: boolean} | null> => ipcRenderer.invoke('pty:unclose', { id }),
    agent: (id: string): Promise<{kind: '' | 'claude' | 'codex'; sessionId: string; args: string[]; alive: boolean}> => ipcRenderer.invoke('pty:agent', { id }),
    resumeCommand: (desc: {kind: string; sessionId?: string; args?: string[]; cwd?: string}): Promise<string> => ipcRenderer.invoke('pty:resumeCommand', desc),
    exec: (id: string, cmd: string): void => ipcRenderer.send('pty:exec', { id, cmd }),
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
  todos: {
    list: (): Promise<TaskList> => ipcRenderer.invoke('todos:list'),
    save: (scope: TaskScope, input: TaskInput): Promise<TaskList> => ipcRenderer.invoke('todos:save', scope, input),
    /** Several at once: one commit for the shared ones. */
    saveMany: (scope: TaskScope, inputs: TaskInput[]): Promise<TaskList> => ipcRenderer.invoke('todos:saveMany', scope, inputs),
    remove: (scope: TaskScope, id: string): Promise<TaskList> => ipcRenderer.invoke('todos:remove', scope, id),
    removeMany: (scope: TaskScope, ids: string[]): Promise<TaskList> => ipcRenderer.invoke('todos:removeMany', scope, ids),
    /** Undo: the tasks written back exactly as given (id, dates, authors). */
    restore: (scope: TaskScope, tasks: Task[]): Promise<TaskList> => ipcRenderer.invoke('todos:restore', scope, tasks),
    /** Private ⇄ shared; to shared it goes to `assignee`, by default the user. `order` places it in the list it goes to. */
    move: (from: TaskScope, id: string, assignee?: Task['assignee'], order?: number): Promise<TaskList> => ipcRenderer.invoke('todos:move', from, id, assignee, order),
    sync: (): Promise<TaskList> => ipcRenderer.invoke('todos:sync'),
    onChanged: (cb: () => void): (() => void) => { ipcRenderer.on('todos:changed', cb); return () => { ipcRenderer.removeListener('todos:changed', cb) } },
  },

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
    add: (label: string): Promise<AccountFlow> => ipcRenderer.invoke('accounts:add', label),
    openInChrome: (flowId: string, profileDir: string): Promise<void> => ipcRenderer.invoke('accounts:open', flowId, profileDir),
    cancel: (flowId: string): Promise<void> => ipcRenderer.invoke('accounts:cancel', flowId),
    remove: (id: string): Promise<void> => ipcRenderer.invoke('accounts:remove', id),
    rename: (id: string, label: string): Promise<void> => ipcRenderer.invoke('accounts:rename', id, label),
    chromeProfiles: (): Promise<ChromeProfile[]> => ipcRenderer.invoke('accounts:chromeProfiles'),
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
