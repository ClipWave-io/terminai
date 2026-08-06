import type { Theme, ThemeName } from './types'

/**
 * Both palettes are deliberately not maximum-contrast: no #fff on #000.
 * The ANSI ramps are tuned so `git diff`, `ls -G` and Claude Code's own
 * output stay legible on each background rather than being an afterthought.
 */

const dusk: Theme = {
  name: 'dusk',
  label: 'Dusk',
  dark: true,

  background: '#16161f',
  surface: '#1c1c27',
  pane: '#191922',
  foreground: '#e6e1d8',
  dim: '#6b6578',
  accent: '#8b7cf6',
  cursor: '#e0a458',
  selection: 'rgba(139, 124, 246, 0.28)',
  border: 'rgba(255, 255, 255, 0.07)',
  shadow: 'rgba(0, 0, 0, 0.45)',

  black: '#3a3646',
  red: '#e26d7a',
  green: '#7fbf8f',
  yellow: '#e0a458',
  blue: '#7aa2f7',
  magenta: '#b48ee8',
  cyan: '#6fc7c3',
  white: '#d6d1c8',
  brightBlack: '#6b6578',
  brightRed: '#f28b96',
  brightGreen: '#97d3a5',
  brightYellow: '#f0bd7a',
  brightBlue: '#9bbaf9',
  brightMagenta: '#c9a9f2',
  brightCyan: '#8ddad6',
  brightWhite: '#f2ede4',
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

export const THEMES: Record<ThemeName, Theme> = { dusk, paper }

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
