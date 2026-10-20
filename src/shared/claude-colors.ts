import type { Theme } from './types'

/**
 * Claude Code's dark theme prints truecolor meant for a dark background: white text and
 * questions, lavender (177,185,249) for paths, skill names, the picked option and the question
 * chip, and a 55,55,55 bar behind the user's prompt. On a light TerminAI theme the white becomes
 * the theme's ink wherever no background is set (so the prompt bar keeps its white text) and the
 * lavender becomes warm tones. Dark themes get the stream unchanged.
 *
 * One remapper per terminal: it carries the background state and a sequence split across chunks.
 */
export type Remap = (data: string) => string

const WARM: Record<string, { accent: string; chip: string }> = {
  linen: { accent: '#8a6239', chip: '#e8dcc6' },
  paper: { accent: '#8a5a2b', chip: '#ead9bd' },
  mint: { accent: '#3d6b52', chip: '#d3e7da' },
}

const rgb = (hex: string) => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)).join(';')
const SGR = /\x1b\[([0-9;]*)m/g
const PARTIAL = /\x1b(\[[0-9;]*)?$/

export function claudeDarkOnLight(theme: Theme): Remap | null {
  if (theme.dark) return null
  const warm = WARM[theme.name] ?? { accent: theme.foreground, chip: theme.surface }
  const ink = rgb(theme.foreground), accent = rgb(warm.accent), chip = rgb(warm.chip)
  let background = false, pending = ''
  const sgr = (body: string): string => {
    const p = body === '' ? ['0'] : body.split(';')
    const out: string[] = []
    for (let i = 0; i < p.length; i++) {
      const n = Number(p[i] || 0)
      if ((n === 38 || n === 48) && p[i + 1] === '2' && i + 4 < p.length) {
        let color = `${p[i + 2]};${p[i + 3]};${p[i + 4]}`
        if (n === 38 && color === '255;255;255' && !background) color = ink
        else if (n === 38 && color === '177;185;249' && !background) color = accent
        else if (n === 48 && color === '177;185;249') color = chip
        if (n === 48) background = true
        out.push(`${n};2;${color}`)
        i += 4
        continue
      }
      if ((n === 38 || n === 48) && p[i + 1] === '5' && i + 2 < p.length) {
        if (n === 48) background = true
        out.push(`${n};5;${p[i + 2]}`)
        i += 2
        continue
      }
      if (n === 0 || n === 49) background = false
      else if ((n >= 40 && n <= 47) || (n >= 100 && n <= 107)) background = true
      out.push(p[i] ?? '')
    }
    return `\x1b[${out.join(';')}m`
  }
  return (data: string) => {
    let text = pending + data
    pending = ''
    const tail = PARTIAL.exec(text)
    if (tail) { pending = tail[0]; text = text.slice(0, tail.index) }
    return text.replace(SGR, (_all, body: string) => sgr(body))
  }
}
