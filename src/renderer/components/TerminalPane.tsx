import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebglAddon } from '@xterm/addon-webgl'
import { toXtermTheme } from '../../shared/themes'
import * as snapshots from '../snapshots'
import type { Theme } from '../../shared/types'
import type { JSX } from 'react'

interface Props {
  ptyId: string
  active: boolean
  theme: Theme
  fontSize: number
  onTitle: (title: string) => void
}

/**
 * Quote a dropped path the way a shell needs it. Single quotes take everything
 * literally, so only an embedded single quote needs the close-escape-reopen
 * dance — which also covers spaces, $, and every other metacharacter.
 */
function shellQuote(path: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(path) ? path : `'${path.replace(/'/g, `'\\''`)}'`
}

/**
 * One xterm bound to one PTY. Instances for inactive tabs stay mounted (hidden
 * via CSS) so background sessions keep drawing and scrollback survives a switch.
 */
export function TerminalPane({ ptyId, active, theme, fontSize, onTitle }: Props): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const lastSize = useRef<{ cols: number; rows: number }>({ cols: 0, rows: 0 })

  // ---- create once per PTY ------------------------------------------------
  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const term = new Terminal({
      fontFamily: '"JetBrainsMono Nerd Font", "SF Mono", Menlo, ui-monospace, monospace',
      fontSize,
      lineHeight: 1.25,
      letterSpacing: 0,
      cursorBlink: true,
      cursorStyle: 'bar',
      cursorWidth: 2,
      allowProposedApi: true,
      scrollback: 20000,
      // Keep the pane background matching the theme even where no cell is drawn.
      theme: toXtermTheme(theme),
      macOptionIsMeta: true,
      macOptionClickForcesSelection: true,
      // Claude Code and every other TUI rely on these; do not turn them off.
      convertEol: false,
      screenReaderMode: false,
    })

    const fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(new WebLinksAddon())

    const unicode = new Unicode11Addon()
    term.loadAddon(unicode)
    term.unicode.activeVersion = '11'

    term.open(host)

    // WebGL is a large win on redraw-heavy TUIs but is unavailable in some GPU
    // configurations; the canvas renderer is a correct fallback.
    try {
      const webgl = new WebglAddon()
      webgl.onContextLoss(() => webgl.dispose())
      term.loadAddon(webgl)
    } catch {
      /* canvas renderer it is */
    }

    termRef.current = term
    fitRef.current = fit

    // Cheap text preview for the grid: read straight off the buffer rather than
    // keeping a second renderer alive per tab.
    snapshots.register(ptyId, (want) => {
      const buf = term.buffer.active
      const out: string[] = []
      const end = buf.baseY + buf.cursorY
      for (let y = Math.max(0, end - want + 1); y <= end; y++) {
        const line = buf.getLine(y)
        if (line) out.push(line.translateToString(true).trimEnd())
      }
      return out
    })

    const offData = window.term.pty.onData((id, data) => {
      if (id === ptyId) term.write(data)
    })
    const offExit = window.term.pty.onExit((id) => {
      if (id === ptyId) term.write('\r\n\x1b[2m[process exited]\x1b[0m\r\n')
    })

    // Only now, with both listeners live, does main start sending. Everything
    // the shell printed before this point — including while the window was
    // closed — arrives as one replayed chunk, exactly once.
    void window.term.pty.attach(ptyId)

    term.onData((d) => window.term.pty.write(ptyId, d))
    // Honour OSC 0/2, which is how shells and TUIs announce what they're doing.
    term.onTitleChange((t) => onTitle(t))

    const sync = (): void => {
      if (!fitRef.current || host.clientWidth === 0 || host.clientHeight === 0) return
      fitRef.current.fit()
      const { cols, rows } = term
      if (cols !== lastSize.current.cols || rows !== lastSize.current.rows) {
        lastSize.current = { cols, rows }
        window.term.pty.resize(ptyId, cols, rows)
      }
    }

    // Debounced, because a window drag fires this continuously and each call
    // sends SIGWINCH to a full-screen TUI.
    let raf = 0
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(sync)
    })
    ro.observe(host)
    sync()

    return () => {
      snapshots.unregister(ptyId)
      offData()
      offExit()
      ro.disconnect()
      cancelAnimationFrame(raf)
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
    // Deliberately keyed on ptyId alone: theme and font are applied below
    // without tearing down the terminal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ptyId])

  // ---- live theme / font updates -----------------------------------------
  useEffect(() => {
    const term = termRef.current
    if (!term) return
    term.options.theme = toXtermTheme(theme)
  }, [theme])

  useEffect(() => {
    const term = termRef.current
    if (!term) return
    term.options.fontSize = fontSize
    fitRef.current?.fit()
    window.term.pty.resize(ptyId, term.cols, term.rows)
  }, [fontSize, ptyId])

  // ---- refit + focus when this tab becomes visible ------------------------
  useEffect(() => {
    if (!active) return
    const term = termRef.current
    if (!term) return
    // A hidden element has no measurable size, so the fit has to wait for paint.
    const id = requestAnimationFrame(() => {
      fitRef.current?.fit()
      window.term.pty.resize(ptyId, term.cols, term.rows)
      term.focus()
    })
    return () => cancelAnimationFrame(id)
  }, [active, ptyId])

  // ---- dropped files paste their path -------------------------------------
  // xterm's own drop handling only understands text, so a Finder drag would
  // otherwise do nothing here (and, without the preventDefault, would make the
  // whole window navigate to the file).
  const onDrop = (e: React.DragEvent<HTMLDivElement>): void => {
    e.preventDefault()
    e.stopPropagation()
    const dropped = Array.from(e.dataTransfer.files)
      .map((f) => window.term.files.pathFor(f))
      .filter(Boolean)

    // A drag from a text editor or the browser carries no file, just a string.
    const text = dropped.length
      ? dropped.map(shellQuote).join(' ')
      : e.dataTransfer.getData('text/uri-list').trim() || e.dataTransfer.getData('text/plain')
    if (!text) return

    // Trailing space so a second drop does not run into the first.
    window.term.pty.write(ptyId, `${text} `)
    termRef.current?.focus()
  }

  return (
    <div
      ref={hostRef}
      className={`term-host${active ? ' active' : ''}`}
      onDragOver={(e) => {
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
      }}
      onDrop={onDrop}
    />
  )
}
