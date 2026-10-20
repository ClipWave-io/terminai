import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebglAddon } from '@xterm/addon-webgl'
import { toXtermTheme } from '../../shared/themes'
import { claudeDarkOnLight, type Remap } from '../../shared/claude-colors'
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

let lastLink = { uri: '', at: 0 }
function openLink(uri: string) {
  if (!/^(https?|mailto|file):/i.test(uri)) return
  if (uri === lastLink.uri && Date.now() - lastLink.at < 500) return
  lastLink = { uri, at: Date.now() }; window.open(uri)
}
function urlAtCell(term: Terminal, col: number, row: number): string {
  const buf = term.buffer.active, y = buf.viewportY + row
  let start = y
  while (start > 0 && buf.getLine(start)?.isWrapped) start--
  let text = ''
  for (let i = start; ; i++) { const line=buf.getLine(i); if(!line || (i>start && !line.isWrapped))break; text+=line.translateToString(false).padEnd(term.cols) }
  const idx=(y-start)*term.cols+col
  for(const match of text.matchAll(/https?:\/\/[^\s"'<>`]+/g)) if(idx>=match.index! && idx<match.index!+match[0].length)return match[0].replace(/[.,;:!?)\]]+$/, '')
  return ''
}
/**
 * Claude Code and Codex both switch on mouse tracking (DECSET 1000/1002/1003),
 * and xterm then forwards every click and drag to the TUI instead of selecting
 * text — so nothing in those boxes could be selected without holding ⌥.
 *
 * This inverts the default: a plain drag always selects. A plain click with no
 * drag is still delivered to the app as a press+release, so Codex's
 * click-to-place-cursor keeps working. ⌥ continues to force selection.
 *
 * Reaches into xterm's private core (pinned to @xterm/xterm 5.5.0); there is no
 * public option for this.
 */
function installSelectionOverride(term: Terminal, host: HTMLElement): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const core = (term as any)._core
  const selection = core?._selectionService
  const mouse = core?.coreMouseService
  const mouseUtil = core?._mouseService
  if (!selection || !mouse || !mouseUtil) return

  selection.shouldForceSelection = (ev: MouseEvent): boolean =>
    ev.button === 0 && !ev.ctrlKey

  let downAt: { x: number; y: number } | null = null
  host.addEventListener(
    'mousedown',
    (ev) => {
      downAt = ev.button === 0 ? { x: ev.clientX, y: ev.clientY } : null
    },
    true,
  )
  host.addEventListener(
    'mouseup',
    (ev) => {
      const start = downAt
      downAt = null
      if (!start || ev.button !== 0 || ev.altKey || !mouse.areMouseEventsActive) return
      const moved = Math.hypot(ev.clientX - start.x, ev.clientY - start.y) > 3
      if (moved || term.hasSelection()) return
      const pos = mouseUtil.getMouseReportCoords(ev, core.screenElement)
      if (!pos) return
      // button 0 = left; action 1 = down, 0 = up (xterm's CoreMouseAction).
      mouse.triggerMouseEvent({ col: pos.col, row: pos.row, x: pos.x, y: pos.y, button: 0, action: 1 })
      mouse.triggerMouseEvent({ col: pos.col, row: pos.row, x: pos.x, y: pos.y, button: 0, action: 0 })
    },
    true,
  )
}

/**
 * One xterm bound to one PTY. Instances for inactive tabs stay mounted (hidden
 * via CSS) so background sessions keep drawing and scrollback survives a switch.
 */
export function TerminalPane({ ptyId, active, theme, fontSize, onTitle }: Props): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  // Claude Code's dark-theme colours, translated for light themes (see claude-colors.ts).
  const remapRef = useRef<Remap | null>(claudeDarkOnLight(theme))
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
      // A program that assumes the opposite background (Claude Code's dark theme on linen
      // printed white-on-white questions) still stays readable: xterm darkens or lightens
      // any foreground below WCAG AA contrast against the cell background.
      minimumContrastRatio: 4.5,
      macOptionIsMeta: true,
      macOptionClickForcesSelection: true,
      // Claude Code and every other TUI rely on these; do not turn them off.
      convertEol: false,
      screenReaderMode: false,
      linkHandler: { activate: (_event, uri) => { if (!term.hasSelection()) openLink(uri) } },
    })

    const fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(new WebLinksAddon((_event, uri) => { if (!term.hasSelection()) openLink(uri) }))

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
    installSelectionOverride(term, host)

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
      if (id === ptyId) term.write(remapRef.current ? remapRef.current(data) : data)
    })
    const offExit = window.term.pty.onExit((id) => {
      if (id === ptyId) term.write('\r\n\x1b[2m[process exited]\x1b[0m\r\n')
    })

    // Only now, with both listeners live, does main start sending. Everything
    // the shell printed before this point — including while the window was
    // closed — arrives as one replayed chunk, exactly once.
    // A tab opened while the terminal pane is hidden has nothing to fit to:
    // take its PTY's size first, or output drawn for that width wraps here and
    // no SIGWINCH ever comes to repaint it once the pane is shown.
    const sized = host.clientWidth && host.clientHeight
      ? Promise.resolve()
      : window.term.pty.size(ptyId).then((s) => { if (s && termRef.current === term) term.resize(s.cols, s.rows) })
    void sized.catch(() => {}).then(() => { if (termRef.current === term) void window.term.pty.attach(ptyId) })

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
    remapRef.current = claudeDarkOnLight(theme)
  }, [theme])

  useEffect(() => {
    const term = termRef.current
    if (!term) return
    term.options.fontSize = fontSize
    // A hidden pane cannot be measured, and xterm's unfitted 80x24 is not a size
    // to give the PTY; the fit on show sends the real one.
    if (!hostRef.current?.clientWidth) return
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
      term.scrollToBottom()
      term.focus()
    })
    return () => cancelAnimationFrame(id)
  }, [active, ptyId])

  useEffect(() => {
    if (!active) return
    const follow = () => { if (document.visibilityState === 'visible') termRef.current?.scrollToBottom() }
    window.addEventListener('focus', follow)
    document.addEventListener('visibilitychange', follow)
    return () => { window.removeEventListener('focus', follow); document.removeEventListener('visibilitychange', follow) }
  }, [active])

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
    const pasteText = () => { window.term.pty.write(ptyId, `${text} `); termRef.current?.focus() }
    if (dropped.length === 1 && e.dataTransfer.files.length === 1 && e.dataTransfer.files[0].type.startsWith('image/')) {
      void window.term.pty.agent(ptyId).then(async agent => {
        if (agent.kind === 'claude' && agent.alive && await window.term.files.stageImage(dropped[0])) window.term.pty.write(ptyId, '\x16')
        else pasteText()
      }).catch(pasteText)
    } else pasteText()
  }

  const downCell = useRef<{col:number;row:number} | null>(null)
  function cellAt(e: React.MouseEvent) {
    const term=termRef.current, screen=hostRef.current?.querySelector('.xterm-screen')
    if(!term||!screen)return null
    const r=screen.getBoundingClientRect(),col=Math.floor((e.clientX-r.left)/r.width*term.cols),row=Math.floor((e.clientY-r.top)/r.height*term.rows)
    return col>=0&&row>=0&&col<term.cols&&row<term.rows?{col,row}:null
  }
  return (
    <div
      ref={hostRef}
      className={`term-host${active ? ' active' : ''}`}
      onDragOver={(e) => {
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
      }}
      onMouseDownCapture={e=>{downCell.current=e.button===0?cellAt(e):null}}
      onMouseUpCapture={e=>{const down=downCell.current,up=cellAt(e),term=termRef.current;downCell.current=null;if(e.button===0&&down&&up&&down.col===up.col&&down.row===up.row&&term&&!term.hasSelection()){const url=urlAtCell(term,up.col,up.row);if(url)openLink(url)}}}
      onPasteCapture={e=>{if(e.clipboardData.getData('text/plain')||!Array.from(e.clipboardData.items).some(i=>i.type.startsWith('image/')))return;e.preventDefault();e.stopPropagation();void window.term.pty.agent(ptyId).then(a=>{if(a.kind==='claude'&&a.alive)window.term.pty.write(ptyId,'\x16')})}}
      onDrop={onDrop}
    />
  )
}
