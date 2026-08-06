export type ThemeName = 'dusk' | 'paper'

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

export interface TabInfo {
  id: string
  title: string
  cwd: string
  /** best-effort: the foreground process name reported by the PTY's shell */
  process: string
  exited: boolean
  /** epoch ms the session was opened — drives the "age" column */
  createdAt: number
  /** cumulative ms this tab has been the focused one */
  focusedMs: number
  /** epoch ms it was last focused, for "last used" */
  lastActiveAt: number
  /** free-text scratch note the user keeps against this session */
  notes: string
}

/** What survives a restart. Order in the array is the user's priority order. */
export interface SavedTab {
  cwd: string
  title: string
  notes: string
  focusedMs: number
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
  theme: ThemeName
  fontSize: number
  /** width of the tab rail in px; drag its right edge to change */
  railWidth: number
  voice: VoicePrefs
  /** restored on launch, in the user's chosen priority order */
  tabs: SavedTab[]
}

export const RAIL_MIN = 150
export const RAIL_MAX = 460
export const RAIL_DEFAULT = 224

export const DEFAULT_PREFS: Prefs = {
  theme: 'dusk',
  fontSize: 13,
  railWidth: RAIL_DEFAULT,
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
  tabs: [],
}
