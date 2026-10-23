export type ThemeName =
  | 'dusk'
  | 'paper'
  | 'midnight'
  | 'forest'
  | 'ember'
  | 'mono'
  | 'nord'
  | 'rose'
  | 'phosphor'
  | 'ocean'
  | 'linen'
  | 'mint'

export interface AnsiRamp {
  black: string
  red: string
  green: string
  yellow: string
  blue: string
  magenta: string
  cyan: string
  white: string
  brightBlack: string
  brightRed: string
  brightGreen: string
  brightYellow: string
  brightBlue: string
  brightMagenta: string
  brightCyan: string
  brightWhite: string
}

export interface Theme extends AnsiRamp {
  name: ThemeName
  label: string
  /** true when the theme is dark; drives vibrancy + traffic-light appearance */
  dark: boolean
  background: string
  /** slightly lifted surface for the rail and dock */
  surface: string
  /** the rounded terminal pane itself */
  pane: string
  foreground: string
  dim: string
  accent: string
  cursor: string
  selection: string
  border: string
  shadow: string
}

export type WorkspacePane = 'files' | 'terminal' | 'browser'
export function normalizePaneOrder(value: unknown): WorkspacePane[] {
  const defaults: WorkspacePane[] = ['files', 'terminal', 'browser']
  return [...new Set([...(Array.isArray(value) ? value.filter((item): item is WorkspacePane => defaults.includes(item)) : []), ...defaults])]
}

export type RailSide = 'left' | 'right'

export type TasksUser = 'livio' | 'ilai'
export type TaskStatus = 'open' | 'doing' | 'done'
export type TaskScope = 'personal' | 'shared'

/** The private list of the tasks without a `list` field: the one there was before there were several. */
export const DEFAULT_LIST = 'private'

/** One to-do, in the format of the build-tasks repo README (one file per task there). */
export interface Task {
  id: string
  title: string
  notes: string
  /** Pictures under the note, file names in the task's own folder (images/<id>/ in the repo, todo-images/<id>/ for a private task). */
  images?: string[]
  status: TaskStatus
  assignee: TasksUser | 'both' | null
  /** free text, e.g. ManyMotions, Abracadabrax, ResumeNext */
  product: string
  /** Place in its list after a cut and paste; without it the task sorts by Date.parse(createdAt). */
  order?: number
  /** A private task's list (TaskList.lists); without it, the first one. Never on a shared task. */
  list?: string
  /** ISO with the Europe/Rome offset */
  createdAt: string
  createdBy: string
  updatedAt: string
  updatedBy: string
}

export interface TasksSync {
  /** false when no shared repository is configured (the test build without TERMINAI_TASKS_REMOTE) */
  enabled: boolean
  syncing: boolean
  /** last successful pull/push, ISO with the Europe/Rome offset */
  lastSync: string | null
  error: string | null
}

export interface TaskList {
  personal: Task[]
  shared: Task[]
  sync: TasksSync
  /** ids of shared tasks the other person added or changed since this person last looked at them */
  unseen: string[]
  /** This person's private lists, the default one first; only on this Mac. */
  lists: TaskListPage[]
  /** The tab working on each task in progress, by task id; only on this Mac, never in the repo. */
  working: Record<string, TaskWorking>
}

/** A private list, shown as a page of the To-do sheet. */
export interface TaskListPage {
  id: string
  name: string
  /** What the list is for, in the user's words: sessions read it to know which list "here" is. */
  about?: string
}

/** Set by `terminai todo start` from a tab: which tab, by its browserKey (it outlives the pty id), and its name then. */
export interface TaskWorking {
  tab: string
  name: string
  /** ISO with the Europe/Rome offset */
  at: string
}

/** One version of a shared task, from the build-tasks history; task is null where a commit deleted it. */
export interface TaskVersion {
  hash: string
  /** commit time, ISO */
  at: string
  message: string
  by: string
  task: Task | null
}

/** What a sync brought in from the other Mac, for the notification. */
export interface TasksChange {
  by: string
  changed: Task[]
  removed: string[]
}

/** What the To-do sheet sends; the main process stamps the dates and authors. */
export type TaskInput = Partial<Pick<Task, 'id' | 'title' | 'notes' | 'status' | 'assignee' | 'product' | 'order' | 'list'>>

/** Assigned to me or to both, or unassigned and created by me. resources/terminai.cjs repeats it for --mine. */
export function isMine(task: Task, user: string): boolean {
  return task.assignee === user || task.assignee === 'both' || (task.assignee === null && task.createdBy === user)
}

/**
 * What the tab's dot reports, in the terms that matter while you are running
 * agents in several tabs at once: green you can use, yellow is busy, blue wants
 * you, and 'question' when the agent has stopped on a prompt and is waiting for
 * an answer (a choice, a permission, the folder trust check, a plan) — the one
 * state no one should miss across a full rail.
 */
export type TabStatus = 'ready' | 'working' | 'waiting' | 'question' | 'exited'

/** The rail buckets a tab under its group when it has one, else under its folder. */
export function groupOf(tab: { group?: string; cwd: string }): string {
  return tab.group || tab.cwd
}

/** The name its owner gave the session; until then, the title the terminal sets for itself. */
export function tabLabel(tab: { customTitle?: string; title: string }): string {
  return tab.customTitle || tab.title
}

export interface TabInfo {
  id: string
  title: string
  customTitle?: string
  name?: string
  /** rail heading this tab sits under instead of its folder; set by `terminai open --group` */
  group?: string
  agent?: string
  browserKey?: string
  agentSession?: string
  agentArgs?: string[]
  cwd: string
  /** best-effort: the foreground process name reported by the PTY's shell */
  process: string
  status: TabStatus
  /** Claude Code has run in this tab, so it is worth resuming on next launch */
  usedClaude: boolean
  exited: boolean
  /** epoch ms the session was opened — drives the "age" column */
  createdAt: number
  /** cumulative ms this tab has been the focused one */
  focusedMs: number
  /** epoch ms it was last focused, for "last used" */
  lastActiveAt: number
  /** free-text scratch note the user keeps against this session */
  notes: string
  /** Claude Code session id minted for this tab; '' until `claude` has run */
  claudeSession: string
  /** the claude/codex under this tab is running right now, not just remembered */
  agentAlive?: boolean
}

/** A Claude Code account a tab can run on (src/main/accounts.ts). */
export interface ClaudeAccount {
  /** 'login' is the sign-in `/login` saved on this Mac; the others are setup-token accounts */
  id: string
  label: string
  login: boolean
  /** epoch ms until which this account's plan is out of usage; 0 when it can be used */
  exhaustedUntil: number
  /** plan usage (0-1) and window resets (epoch ms) from the last answer Anthropic gave this account */
  usage?: { fiveHour: number; fiveReset: number; week: number; weekReset: number; at: number }
}

export interface ClaudeAccounts {
  /** auto: a tab whose plan runs out moves by itself to the next account with usage left */
  mode: 'manual' | 'auto'
  /** the account new tabs start on */
  defaultId: string
  accounts: ClaudeAccount[]
}

/** Adding an account: `claude setup-token` runs out of sight and the user approves it in Chrome. */
export interface AccountFlow {
  id: string
  label: string
  stage: 'starting' | 'waiting' | 'saved' | 'error'
  /** the sign-in link, once claude has made it */
  url?: string
  error?: string
}

export interface ChromeProfile {
  dir: string
  name: string
}

/** What survives a restart. Order in the array is the user's priority order. */
export interface SavedTab {
  cwd: string
  customTitle?: string
  name?: string
  group?: string
  agent?: string
  browserKey?: string
  agentSession?: string
  agentArgs?: string[]
  title: string
  notes: string
  focusedMs: number
  /**
   * The PTY this tab was showing. Only meaningful while the app is still
   * running: closing the window on macOS leaves the shells alive, so reopening
   * matches on this and adopts the same session instead of starting a new one.
   * After a real quit no session matches and the tab restores from scratch.
   */
  ptyId?: string
  /**
   * Claude Code was in the foreground when the app closed. On the next launch
   * the tab picks the conversation back up rather than dropping you at a bare
   * prompt with the session still sitting there unresumed.
   */
  claude?: boolean
  /**
   * The exact conversation this tab was in. Without it, several tabs open on
   * one folder all resume the same "most recent" conversation and the rest are
   * lost.
   */
  claudeSession?: string
}

export interface VoiceClip {
  id: string
  text: string
  /** file:// URL of the synthesized audio, playable by an <audio> element */
  url: string
  /** absolute path on disk, used by "save a copy" */
  path: string
  engine: VoiceEngine
  createdAt: number
  /** id of the tab this clip is attributed to, best-effort; null when unknown */
  tabId: string | null
}

export type VoiceEngine = 'say' | 'elevenlabs' | 'local'

export interface VoicePrefs {
  enabled: boolean
  autoplay: boolean
  engine: VoiceEngine
  sayVoice: string
  elevenVoiceId: string
  /** Kokoro speaker id, used by the free on-device engine */
  localVoice: string
  /** 0..1, applied at playback time, not at synthesis time */
  volume: number
}

export interface Prefs {
  hiddenToolbarItems: string[]
  paneOrder: WorkspacePane[]
  theme: ThemeName
  fontSize: number
  /** width of the tab rail in px; drag its inner edge to change */
  railWidth: number
  /** rail collapsed out of view; toggled with ⌘S. Width is remembered. */
  railHidden: boolean
  /** which edge the rail sits on; toggled with ⌥⌘S */
  railSide: RailSide
  /** voice dock collapsed out of view; toggled with ⌘D. Voice still generates. */
  voiceDockHidden: boolean
  voice: VoicePrefs
  /** false until the first-run welcome has been dismissed */
  seenWelcome: boolean
  /** sidebar sessions bucketed under a heading per folder */
  groupByFolder: boolean
  /** who edits the to-do list on this Mac; '' until chosen in the To-do sheet */
  tasksUser: TasksUser | ''
  /** restored on launch, in the user's chosen priority order */
  tabs: SavedTab[]
}

export const RAIL_MIN = 150
export const RAIL_MAX = 460
export const RAIL_DEFAULT = 224

export const DEFAULT_PREFS: Prefs = {
  hiddenToolbarItems: [],
  paneOrder: ['files', 'terminal', 'browser'],
  theme: 'linen',
  fontSize: 13,
  railWidth: RAIL_DEFAULT,
  railHidden: false,
  railSide: 'left',
  voiceDockHidden: false,
  voice: {
    enabled: true,
    autoplay: true,
    // Local first: free, on-device, and good. synthesize() walks down to
    // ElevenLabs and then `say` when it is not installed.
    engine: 'local',
    sayVoice: 'Samantha',
    elevenVoiceId: '21m00Tcm4TlvDq8ikWAM',
    localVoice: 'af_heart',
    volume: 1,
  },
  seenWelcome: false,
  groupByFolder: true,
  tasksUser: '',
  tabs: [],
}
