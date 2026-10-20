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

/**
 * What the tab's dot reports, in the terms that matter while you are running
 * agents in several tabs at once: green you can use, yellow is busy, blue wants
 * you.
 */
export type TabStatus = 'ready' | 'working' | 'waiting' | 'exited'

/** The rail buckets a tab under its group when it has one, else under its folder. */
export function groupOf(tab: { group?: string; cwd: string }): string {
  return tab.group || tab.cwd
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
  tabs: [],
}
