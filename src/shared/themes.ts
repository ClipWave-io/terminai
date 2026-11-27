import type { Theme, ThemeName } from './types'

/**
 * Both palettes are deliberately not maximum-contrast: no #fff on #000.
 * The ANSI ramps are tuned so `git diff`, `ls -G` and Claude Code's own
 * output stay legible on each background rather than being an afterthought.
 */

const dusk: Theme = {
  name: 'dusk',
  // Muted, easy on the eyes (26 Nov 2026: the neon palettes were replaced).
  label: 'Graphite',
  dark: true,

  background: '#161719',
  surface: '#1f2124',
  pane: '#1a1b1e',
  foreground: '#d4d6da',
  dim: '#6e737b',
  accent: '#8fa8c8',
  cursor: '#8fa8c8',
  selection: 'rgba(143, 168, 200, 0.24)',
  border: 'rgba(255, 255, 255, 0.07)',
  shadow: 'rgba(0, 0, 0, 0.50)',

  black: '#2c313b',
  red: '#d9838c',
  green: '#8fbf96',
  yellow: '#d6b27e',
  blue: '#86a9d6',
  magenta: '#b49bd4',
  cyan: '#80bcc4',
  white: '#c3c8d0',
  brightBlack: '#6b7280',
  brightRed: '#e89aa2',
  brightGreen: '#a6cfac',
  brightYellow: '#e4c597',
  brightBlue: '#a0bde3',
  brightMagenta: '#c7b2e0',
  brightCyan: '#99ccd3',
  brightWhite: '#eceff3',
}

const paper: Theme = {
  name: 'paper',
  label: 'Paper',
  dark: false,

  background: '#f6f1e8',
  surface: '#efe8dc',
  pane: '#fbf7f0',
  foreground: '#2e2a24',
  dim: '#8a8378',
  accent: '#6d5bd0',
  cursor: '#b5762a',
  selection: 'rgba(109, 91, 208, 0.22)',
  border: 'rgba(46, 42, 36, 0.10)',
  shadow: 'rgba(46, 42, 36, 0.14)',

  black: '#2e2a24',
  red: '#b3384a',
  green: '#4a8a5c',
  yellow: '#b5762a',
  blue: '#3b62b5',
  magenta: '#7d4bb0',
  cyan: '#2b7d78',
  white: '#6a6459',
  brightBlack: '#8a8378',
  brightRed: '#c95063',
  brightGreen: '#5c9e6e',
  brightYellow: '#c98a3d',
  brightBlue: '#4f76c9',
  brightMagenta: '#9260c4',
  brightCyan: '#38928c',
  brightWhite: '#3c372f',
}

const midnight: Theme = {
  name: 'midnight',
  label: 'Midnight',
  dark: true,

  background: '#0f1420',
  surface: '#161d2c',
  pane: '#121826',
  foreground: '#d7dded',
  dim: '#63708c',
  accent: '#5b9cf8',
  cursor: '#f0b76c',
  selection: 'rgba(91, 156, 248, 0.26)',
  border: 'rgba(255, 255, 255, 0.07)',
  shadow: 'rgba(0, 0, 0, 0.50)',

  black: '#2a3348',
  red: '#ef6f7c',
  green: '#6fd08c',
  yellow: '#f0b76c',
  blue: '#5b9cf8',
  magenta: '#a98bf5',
  cyan: '#55c4d4',
  white: '#c6cfe0',
  brightBlack: '#63708c',
  brightRed: '#ff8b96',
  brightGreen: '#8adfa4',
  brightYellow: '#ffd08e',
  brightBlue: '#85b8ff',
  brightMagenta: '#c1a7fa',
  brightCyan: '#74dbe9',
  brightWhite: '#eef3ff',
}

const forest: Theme = {
  name: 'forest',
  // Muted, easy on the eyes (26 Nov 2026: the neon palettes were replaced).
  label: 'Moss',
  dark: true,

  background: '#141a16',
  surface: '#1c241f',
  pane: '#18201b',
  foreground: '#d3dbd5',
  dim: '#6c7b71',
  accent: '#8fb39a',
  cursor: '#8fb39a',
  selection: 'rgba(143, 179, 154, 0.24)',
  border: 'rgba(255, 255, 255, 0.07)',
  shadow: 'rgba(0, 0, 0, 0.50)',

  black: '#2c313b',
  red: '#d9838c',
  green: '#8fbf96',
  yellow: '#d6b27e',
  blue: '#86a9d6',
  magenta: '#b49bd4',
  cyan: '#80bcc4',
  white: '#c3c8d0',
  brightBlack: '#6b7280',
  brightRed: '#e89aa2',
  brightGreen: '#a6cfac',
  brightYellow: '#e4c597',
  brightBlue: '#a0bde3',
  brightMagenta: '#c7b2e0',
  brightCyan: '#99ccd3',
  brightWhite: '#eceff3',
}

const ember: Theme = {
  name: 'ember',
  // Muted, easy on the eyes (26 Nov 2026: the neon palettes were replaced).
  label: 'Plum',
  dark: true,

  background: '#1a1520',
  surface: '#231c2b',
  pane: '#1e1825',
  foreground: '#ddd6e6',
  dim: '#7f7392',
  accent: '#b39bd5',
  cursor: '#b39bd5',
  selection: 'rgba(179, 155, 213, 0.24)',
  border: 'rgba(255, 255, 255, 0.07)',
  shadow: 'rgba(0, 0, 0, 0.50)',

  black: '#2c313b',
  red: '#d9838c',
  green: '#8fbf96',
  yellow: '#d6b27e',
  blue: '#86a9d6',
  magenta: '#b49bd4',
  cyan: '#80bcc4',
  white: '#c3c8d0',
  brightBlack: '#6b7280',
  brightRed: '#e89aa2',
  brightGreen: '#a6cfac',
  brightYellow: '#e4c597',
  brightBlue: '#a0bde3',
  brightMagenta: '#c7b2e0',
  brightCyan: '#99ccd3',
  brightWhite: '#eceff3',
}

const mono: Theme = {
  name: 'mono',
  label: 'Mono',
  dark: true,

  background: '#141414',
  surface: '#1d1d1d',
  pane: '#181818',
  foreground: '#e0e0e0',
  dim: '#7a7a7a',
  accent: '#b8b8b8',
  cursor: '#e8e8e8',
  selection: 'rgba(200, 200, 200, 0.22)',
  border: 'rgba(255, 255, 255, 0.08)',
  shadow: 'rgba(0, 0, 0, 0.50)',

  black: '#3a3a3a',
  red: '#c58a8a',
  green: '#9db99d',
  yellow: '#c9bd8e',
  blue: '#8fa5bd',
  magenta: '#b39fbd',
  cyan: '#8fb8b8',
  white: '#cfcfcf',
  brightBlack: '#7a7a7a',
  brightRed: '#dba3a3',
  brightGreen: '#b5d0b5',
  brightYellow: '#e0d4a5',
  brightBlue: '#a8bdd4',
  brightMagenta: '#ccb8d4',
  brightCyan: '#a8d0d0',
  brightWhite: '#f0f0f0',
}

const nord: Theme = {
  name: 'nord',
  // Muted, easy on the eyes (26 Nov 2026: the neon palettes were replaced).
  label: 'Nord',
  dark: true,

  background: '#2b303b',
  surface: '#343b48',
  pane: '#2f3542',
  foreground: '#d8dee9',
  dim: '#7b8597',
  accent: '#88b8c8',
  cursor: '#88b8c8',
  selection: 'rgba(136, 184, 200, 0.24)',
  border: 'rgba(255, 255, 255, 0.07)',
  shadow: 'rgba(0, 0, 0, 0.50)',

  black: '#2c313b',
  red: '#d9838c',
  green: '#8fbf96',
  yellow: '#d6b27e',
  blue: '#86a9d6',
  magenta: '#b49bd4',
  cyan: '#80bcc4',
  white: '#c3c8d0',
  brightBlack: '#6b7280',
  brightRed: '#e89aa2',
  brightGreen: '#a6cfac',
  brightYellow: '#e4c597',
  brightBlue: '#a0bde3',
  brightMagenta: '#c7b2e0',
  brightCyan: '#99ccd3',
  brightWhite: '#eceff3',
}

const rose: Theme = {
  name: 'rose',
  // Muted, easy on the eyes (26 Nov 2026: the neon palettes were replaced).
  label: 'Dune',
  dark: true,

  background: '#1d1b18',
  surface: '#27241f',
  pane: '#22201c',
  foreground: '#e2ddd5',
  dim: '#847d72',
  accent: '#cfa46c',
  cursor: '#cfa46c',
  selection: 'rgba(207, 164, 108, 0.24)',
  border: 'rgba(255, 255, 255, 0.07)',
  shadow: 'rgba(0, 0, 0, 0.50)',

  black: '#2c313b',
  red: '#d9838c',
  green: '#8fbf96',
  yellow: '#d6b27e',
  blue: '#86a9d6',
  magenta: '#b49bd4',
  cyan: '#80bcc4',
  white: '#c3c8d0',
  brightBlack: '#6b7280',
  brightRed: '#e89aa2',
  brightGreen: '#a6cfac',
  brightYellow: '#e4c597',
  brightBlue: '#a0bde3',
  brightMagenta: '#c7b2e0',
  brightCyan: '#99ccd3',
  brightWhite: '#eceff3',
}

/** Green-on-black, the way a VT220 looked. Deliberately narrow-gamut. */
const phosphor: Theme = {
  name: 'phosphor',
  // Muted, easy on the eyes (26 Nov 2026: the neon palettes were replaced).
  label: 'Espresso',
  dark: true,

  background: '#1c1714',
  surface: '#26201c',
  pane: '#211b18',
  foreground: '#e3d9d0',
  dim: '#877a6e',
  accent: '#c9a27e',
  cursor: '#c9a27e',
  selection: 'rgba(201, 162, 126, 0.24)',
  border: 'rgba(255, 255, 255, 0.07)',
  shadow: 'rgba(0, 0, 0, 0.50)',

  black: '#2c313b',
  red: '#d9838c',
  green: '#8fbf96',
  yellow: '#d6b27e',
  blue: '#86a9d6',
  magenta: '#b49bd4',
  cyan: '#80bcc4',
  white: '#c3c8d0',
  brightBlack: '#6b7280',
  brightRed: '#e89aa2',
  brightGreen: '#a6cfac',
  brightYellow: '#e4c597',
  brightBlue: '#a0bde3',
  brightMagenta: '#c7b2e0',
  brightCyan: '#99ccd3',
  brightWhite: '#eceff3',
}

const ocean: Theme = {
  name: 'ocean',
  // Muted, easy on the eyes (26 Nov 2026: the neon palettes were replaced).
  label: 'Slate',
  dark: true,

  background: '#121a22',
  surface: '#1a242e',
  pane: '#161f28',
  foreground: '#d2dbe4',
  dim: '#687a8c',
  accent: '#7aa5c4',
  cursor: '#7aa5c4',
  selection: 'rgba(122, 165, 196, 0.24)',
  border: 'rgba(255, 255, 255, 0.07)',
  shadow: 'rgba(0, 0, 0, 0.50)',

  black: '#2c313b',
  red: '#d9838c',
  green: '#8fbf96',
  yellow: '#d6b27e',
  blue: '#86a9d6',
  magenta: '#b49bd4',
  cyan: '#80bcc4',
  white: '#c3c8d0',
  brightBlack: '#6b7280',
  brightRed: '#e89aa2',
  brightGreen: '#a6cfac',
  brightYellow: '#e4c597',
  brightBlue: '#a0bde3',
  brightMagenta: '#c7b2e0',
  brightCyan: '#99ccd3',
  brightWhite: '#eceff3',
}

// The original Linen, back by request (26 Nov 2026).
const linen: Theme = {
  name: 'linen',
  label: 'Linen',
  dark: false,

  background: '#f2f0ec',
  surface: '#e9e6e0',
  pane: '#f9f8f5',
  foreground: '#33312d',
  dim: '#8b877f',
  accent: '#4a7fb5',
  cursor: '#a8702f',
  selection: 'rgba(74, 127, 181, 0.20)',
  border: 'rgba(51, 49, 45, 0.10)',
  shadow: 'rgba(51, 49, 45, 0.13)',

  black: '#33312d',
  red: '#ad4046',
  green: '#43855c',
  yellow: '#a8702f',
  blue: '#35619f',
  magenta: '#7a4a9e',
  cyan: '#2a7a76',
  white: '#6b675f',
  brightBlack: '#8b877f',
  brightRed: '#c25a60',
  brightGreen: '#55a071',
  brightYellow: '#c08842',
  brightBlue: '#4a7ac0',
  brightMagenta: '#9163b5',
  brightCyan: '#38928d',
  brightWhite: '#45423b',
}

const sand: Theme = {
  name: 'sand',
  // Muted, easy on the eyes (26 Nov 2026: the neon palettes were replaced).
  label: 'Sand',
  dark: false,

  background: '#f4efe6',
  surface: '#ebe4d8',
  pane: '#f8f4ed',
  foreground: '#3a3530',
  dim: '#8a8173',
  accent: '#94683d',
  cursor: '#94683d',
  selection: 'rgba(148, 104, 61, 0.2)',
  border: 'rgba(0, 0, 0, 0.08)',
  shadow: 'rgba(60, 50, 40, 0.14)',

  black: '#3c372f',
  red: '#b3384a',
  green: '#4a8a5c',
  yellow: '#b5762a',
  blue: '#3b62b5',
  magenta: '#7d4bb0',
  cyan: '#2b7d78',
  white: '#6a6459',
  brightBlack: '#8a8378',
  brightRed: '#c95063',
  brightGreen: '#5c9e6e',
  brightYellow: '#c98a3d',
  brightBlue: '#4f76c9',
  brightMagenta: '#9260c4',
  brightCyan: '#38928c',
  brightWhite: '#2a2622',
}

const mint: Theme = {
  name: 'mint',
  // Muted, easy on the eyes (26 Nov 2026: the neon palettes were replaced).
  label: 'Fog',
  dark: false,

  background: '#eef1f4',
  surface: '#e2e7ec',
  pane: '#f6f8fa',
  foreground: '#2c3440',
  dim: '#7a8594',
  accent: '#4f78ad',
  cursor: '#4f78ad',
  selection: 'rgba(79, 120, 173, 0.2)',
  border: 'rgba(0, 0, 0, 0.08)',
  shadow: 'rgba(60, 50, 40, 0.14)',

  black: '#3c372f',
  red: '#b3384a',
  green: '#4a8a5c',
  yellow: '#b5762a',
  blue: '#3b62b5',
  magenta: '#7d4bb0',
  cyan: '#2b7d78',
  white: '#6a6459',
  brightBlack: '#8a8378',
  brightRed: '#c95063',
  brightGreen: '#5c9e6e',
  brightYellow: '#c98a3d',
  brightBlue: '#4f76c9',
  brightMagenta: '#9260c4',
  brightCyan: '#38928c',
  brightWhite: '#2a2622',
}

/** Insertion order is the order the picker lists them and ⇧⌘L cycles them. */
export const THEMES: Record<ThemeName, Theme> = {
  dusk,
  midnight,
  nord,
  ocean,
  forest,
  phosphor,
  ember,
  rose,
  mono,
  paper,
  linen,
  sand,
  mint,
}

export const THEME_ORDER = Object.keys(THEMES) as ThemeName[]

/** Next palette in THEME_ORDER, wrapping. Drives ⇧⌘L. */
export function nextTheme(name: ThemeName): ThemeName {
  const i = THEME_ORDER.indexOf(name)
  return THEME_ORDER[(i + 1) % THEME_ORDER.length]!
}

export function getTheme(name: ThemeName): Theme {
  return THEMES[name] ?? dusk
}

/** xterm.js wants its own shape; keep the mapping in one place. */
export function toXtermTheme(t: Theme) {
  return {
    background: t.pane,
    foreground: t.foreground,
    cursor: t.cursor,
    cursorAccent: t.pane,
    selectionBackground: t.selection,
    black: t.black,
    red: t.red,
    green: t.green,
    yellow: t.yellow,
    blue: t.blue,
    magenta: t.magenta,
    cyan: t.cyan,
    white: t.white,
    brightBlack: t.brightBlack,
    brightRed: t.brightRed,
    brightGreen: t.brightGreen,
    brightYellow: t.brightYellow,
    brightBlue: t.brightBlue,
    brightMagenta: t.brightMagenta,
    brightCyan: t.brightCyan,
    brightWhite: t.brightWhite,
  }
}
