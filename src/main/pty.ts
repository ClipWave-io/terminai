import * as pty from '@homebridge/node-pty-prebuilt-multiarch'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { existsSync } from 'node:fs'
import type { WebContents } from 'electron'

interface Session {
  id: string
  proc: pty.IPty
  cwd: string
  exited: boolean
}

const sessions = new Map<string, Session>()

/**
 * The user's login shell, so .zshrc runs and PATH / ANTHROPIC_BASE_URL are what
 * they are in any other terminal. Falling back to zsh rather than sh keeps
 * macOS defaults intact.
 */
function loginShell(): string {
  const s = process.env.SHELL
  return s && existsSync(s) ? s : '/bin/zsh'
}

/**
 * Claude Code runs as a fullscreen TUI. It needs a truecolor-capable TERM or it
 * degrades to a washed-out 16-colour rendering, so these two are not optional.
 */
function ptyEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string') env[k] = v
  }
  env.TERM = 'xterm-256color'
  env.COLORTERM = 'truecolor'
  env.TERM_PROGRAM = 'clipwave-term'
  // Electron injects these into child processes; they confuse node tooling
  // launched from the shell, so strip them.
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_NO_ATTACH_CONSOLE
  return env
}

export function createSession(
  wc: WebContents,
  opts: { cwd?: string; cols?: number; rows?: number } = {},
): { id: string; cwd: string } {
  const id = randomUUID()
  const cwd = opts.cwd && existsSync(opts.cwd) ? opts.cwd : homedir()

  const proc = pty.spawn(loginShell(), ['-l'], {
    name: 'xterm-256color',
    cols: opts.cols ?? 80,
    rows: opts.rows ?? 24,
    cwd,
    env: ptyEnv(),
  })

  const session: Session = { id, proc, cwd, exited: false }
  sessions.set(id, session)

  proc.onData((data) => {
    if (!wc.isDestroyed()) wc.send('pty:data', { id, data })
  })

  proc.onExit(({ exitCode }) => {
    session.exited = true
    if (!wc.isDestroyed()) wc.send('pty:exit', { id, exitCode })
    sessions.delete(id)
  })

  return { id, cwd }
}

export function write(id: string, data: string): void {
  sessions.get(id)?.proc.write(data)
}

export function resize(id: string, cols: number, rows: number): void {
  const s = sessions.get(id)
  if (!s || s.exited) return
  // node-pty throws on non-positive dimensions, which happens while the window
  // is animating or the pane is hidden.
  if (cols < 1 || rows < 1) return
  try {
    s.proc.resize(cols, rows)
  } catch {
    /* the process raced us to exit; nothing to resize */
  }
}

export function kill(id: string): void {
  const s = sessions.get(id)
  if (!s) return
  try {
    s.proc.kill()
  } catch {
    /* already gone */
  }
  sessions.delete(id)
}

export function killAll(): void {
  for (const id of [...sessions.keys()]) kill(id)
}

/**
 * Best-effort foreground process name, used for the dot on each tab row and to
 * attribute a voice clip to the tab that most likely produced it.
 */
export function foregroundProcess(id: string): string {
  const s = sessions.get(id)
  if (!s || s.exited) return ''
  try {
    return s.proc.process || ''
  } catch {
    return ''
  }
}

export function cwdOf(id: string): string {
  return sessions.get(id)?.cwd ?? homedir()
}

export function liveIds(): string[] {
  return [...sessions.keys()]
}
