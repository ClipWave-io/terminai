import * as pty from '@homebridge/node-pty-prebuilt-multiarch'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  readdirSync,
  statSync,
} from 'node:fs'
import { basename, join } from 'node:path'
import { execFile } from 'node:child_process'
import { app } from 'electron'
import type { WebContents } from 'electron'
import type { TabStatus } from '../shared/types'

interface Session {
  id: string
  proc: pty.IPty
  cwd: string
  exited: boolean
  /**
   * The window currently showing this session, or null between one window
   * closing and the next attaching. Output written while it is null is held in
   * `buf` and flushed on attach, so closing the window loses nothing.
   */
  wc: WebContents | null
  /** recent output, replayed into a newly attached window */
  buf: string
  /** exit code that arrived with no window to tell; delivered on attach */
  pendingExit: number | null
  /** epoch ms of the last byte the process wrote — silence means it stopped working */
  lastDataAt: number
  /** the process rang the terminal bell, which Claude Code does when it wants you */
  belled: boolean
  /**
   * Claude Code has been seen running in this tab at some point. Latched rather
   * than sampled: node-pty reports the *foreground* process, and while Claude
   * is running a tool that is `node`, not `claude`, so any single sample is
   * likely to miss it.
   */
  sawClaude: boolean
}

const sessions = new Map<string, Session>()

/**
 * How much output to hold per tab for replay. 20k lines of scrollback would be
 * truer to what xterm keeps, but this is measured against a window being closed
 * and reopened, not against restarting: a screenful of context and whatever the
 * session printed while it was hidden is what actually matters, and holding
 * megabytes per tab for the rest of the process's life is not worth it.
 */
const BUF_LIMIT = 512 * 1024

/**
 * Send to a window's renderer without ever letting a failure propagate. This is
 * load-bearing on the PTY data path: those sends run inside node-pty's N-API
 * callback, and an exception escaping there aborts the process rather than
 * rejecting a promise. isDestroyed() catches the common case; the try/catch
 * catches the race where the frame is disposed mid-send. Returns whether the
 * payload was actually handed to a live window.
 */
function safeSend(wc: WebContents | null, channel: string, payload: unknown): boolean {
  if (!wc || wc.isDestroyed()) return false
  try {
    wc.send(channel, payload)
    return true
  } catch {
    return false
  }
}

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
 * A `claude` that runs before the real one and gives this tab its own session
 * id. Claude Code will happily tell you nothing about which conversation a
 * given terminal is in — no pid in the transcript, and it closes the file
 * between writes — so the only reliable way to know is to choose the id
 * ourselves on the way in.
 */
const SHIM = `#!/bin/sh
# TerminAI: give this tab its own Claude session id, so reopening the app can
# resume this conversation and not some other tab's. Take ourselves off PATH
# first — we are the first entry, so \`claude\` below is the real one.
PATH=\${PATH#"$CLIPWAVE_SHIM":}
export PATH

# Resuming by id, or naming one yourself: that id *is* this tab's conversation
# from here on, so record it and get out of the way.
prev=
for arg in "$@"; do
  case $prev in
    -r|--resume|--session-id)
      case $arg in
        -*) ;;
        *) printf '%s\\n' "$arg" > "$CLIPWAVE_SESSION_FILE" ;;
      esac
      break ;;
  esac
  prev=$arg
done
case " $* " in
  *" -r "*|*" --resume "*|*" --session-id "*) exec claude "$@" ;;
esac

# \`--continue\` means "the newest conversation in this folder" — it never tells
# us which one that was, and a tab that only ever resumes would keep no id at
# all. Resolve it to a concrete id here so the tab has one to come back to.
case " $* " in
  *" -c "*|*" --continue "*)
    # printf, not \`pwd\`: the trailing newline would become a trailing dash and
    # the folder would never match.
    slug=$(printf '%s' "$PWD" | tr -c 'a-zA-Z0-9' '-')
    newest=$(ls -t "$HOME/.claude/projects/$slug"/*.jsonl 2>/dev/null | head -1)
    if [ -n "$newest" ]; then
      id=$(basename "$newest" .jsonl)
      printf '%s\\n' "$id" > "$CLIPWAVE_SESSION_FILE"
      # Drop the flag we are replacing; everything else the user typed stays.
      rest=
      for arg in "$@"; do
        case $arg in
          -c|--continue) ;;
          *) rest="$rest \\"$arg\\"" ;;
        esac
      done
      eval "exec claude --resume \\"$id\\"$rest"
    fi
    exec claude "$@" ;;
esac

id=$(uuidgen)
printf '%s\\n' "$id" > "$CLIPWAVE_SESSION_FILE"
exec claude --session-id "$id" "$@"
`

function shimDir(): string {
  return join(app.getPath('userData'), 'shim')
}

function sessionIdFile(tabId: string): string {
  return join(app.getPath('userData'), 'sessions', `${tabId}.id`)
}

/**
 * Tab ids are regenerated every launch, so yesterday's id files are orphans.
 * Swept on a timer rather than on close: `kill` also runs during quit, and
 * deleting there would throw away the very ids the next launch needs.
 */
function pruneSessionIds(): void {
  const dir = join(app.getPath('userData'), 'sessions')
  const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1000
  try {
    for (const f of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, f.name)
      if (statSync(path).mtimeMs < cutoff) rmSync(path, { force: true })
    }
  } catch {
    /* nothing to prune */
  }
}

/** Written once per launch, so an upgraded shim replaces an older one. */
let shimReady = false
function ensureShim(): boolean {
  if (shimReady) return true
  try {
    mkdirSync(shimDir(), { recursive: true })
    mkdirSync(join(app.getPath('userData'), 'sessions'), { recursive: true })
    writeFileSync(join(shimDir(), 'claude'), SHIM, { mode: 0o755 })
    shimReady = true
    pruneSessionIds()
  } catch (err) {
    // Without the shim we simply fall back to `claude --continue` on restore,
    // exactly as before. Not worth failing a tab over.
    console.error('[pty] could not install claude shim:', err)
  }
  return shimReady
}

/**
 * Claude Code runs as a fullscreen TUI. It needs a truecolor-capable TERM or it
 * degrades to a washed-out 16-colour rendering, so these two are not optional.
 */
function ptyEnv(tabId: string): Record<string, string> {
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

  // If this app was itself launched from inside a Claude Code session, it
  // inherited that session's markers. Passing them on makes every `claude` run
  // in a tab believe it is a *child* session, which silently disables
  // transcript saving — and with no transcript, the Stop hook has nothing to
  // scrape, so spoken.txt is never written and the voice goes quiet.
  // A terminal's job is to hand each tab a clean top-level session.
  for (const key of Object.keys(env)) {
    if (key.startsWith('CLAUDE_CODE_') || key === 'CLAUDECODE' || key === 'CLAUDE_PID') {
      delete env[key]
    }
  }

  // Put our `claude` ahead of the real one for this tab only, and tell it where
  // to record the id it mints.
  if (ensureShim()) {
    env.CLIPWAVE_SHIM = shimDir()
    env.CLIPWAVE_SESSION_FILE = sessionIdFile(tabId)
    env.PATH = `${shimDir()}:${env.PATH ?? ''}`
  }

  return env
}

export function createSession(opts: { cwd?: string; cols?: number; rows?: number } = {}): {
  id: string
  cwd: string
} {
  const id = randomUUID()
  const cwd = opts.cwd && existsSync(opts.cwd) ? opts.cwd : homedir()

  const proc = pty.spawn(loginShell(), ['-l'], {
    name: 'xterm-256color',
    cols: opts.cols ?? 80,
    rows: opts.rows ?? 24,
    cwd,
    env: ptyEnv(id),
  })

  const session: Session = {
    id,
    proc,
    cwd,
    exited: false,
    lastDataAt: Date.now(),
    belled: false,
    sawClaude: false,
    // Bound by attach(), once the renderer has a terminal listening. Anything
    // the shell prints before then is held rather than dropped on the floor.
    wc: null,
    buf: '',
    pendingExit: null,
  }
  sessions.set(id, session)
  startSessionSweep()

  proc.onData((data) => {
    session.lastDataAt = Date.now()
    if (data.includes('\x07')) session.belled = true
    session.buf = (session.buf + data).slice(-BUF_LIMIT)
    // If the send throws, it must never escape this callback: node-pty invokes
    // it through an N-API ThreadSafeFunction and re-throws anything that comes
    // back as a C++ exception, which is uncaught and aborts the whole process
    // (SIGABRT). isDestroyed() is not enough — a frame can be disposed between
    // the check and the send while a window is closing or reloading.
    if (!safeSend(session.wc, 'pty:data', { id, data })) session.wc = null
  })

  proc.onExit(({ exitCode }) => {
    session.exited = true
    if (session.wc && safeSend(session.wc, 'pty:exit', { id, exitCode })) {
      sessions.delete(id)
    } else {
      // Nobody to tell yet (or the window just went away). Hold the session so
      // the next window can adopt it, print the exit notice, and see what it
      // left on screen.
      session.pendingExit = exitCode
    }
  })

  return { id, cwd }
}

/** Live sessions a newly opened window can adopt instead of spawning fresh ones. */
export function list(): { id: string; cwd: string; exited: boolean }[] {
  return [...sessions.values()].map((s) => ({ id: s.id, cwd: s.cwd, exited: s.exited }))
}

/**
 * Point a session at the window now showing it and replay what it has printed.
 *
 * Called by every terminal pane on mount, new or adopted, which is what keeps
 * the replay exactly-once: output goes to `buf` and nowhere else until the
 * renderer is listening, and the flush and the rebind happen in the same tick.
 */
export function attach(wc: WebContents, id: string): boolean {
  const s = sessions.get(id)
  if (!s) return false
  if (s.buf) safeSend(wc, 'pty:data', { id, data: s.buf })
  s.wc = wc
  if (s.pendingExit !== null) {
    safeSend(wc, 'pty:exit', { id, exitCode: s.pendingExit })
    sessions.delete(id)
  }
  return true
}

/** Drop the window binding without touching the shell, so output starts buffering again. */
export function detachAll(): void {
  for (const s of sessions.values()) s.wc = null
}

export function write(id: string, data: string): void {
  const s = sessions.get(id)
  if (!s) return
  // Typing into a tab is the answer to whatever it was asking for.
  s.belled = false
  s.proc.write(data)
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

let sessionSweep: ReturnType<typeof setInterval> | null = null

/**
 * Follow each tab into whatever folder it is actually in. The cwd handed to
 * pty.spawn is only where the shell *started*; `cd` never touches it, which is
 * why every row used to name the folder the tab was born in forever.
 *
 * One `lsof` covers every tab — it takes a comma-separated pid list — so this
 * costs a single spawn no matter how many tabs are open.
 */
function refreshCwds(): void {
  const live = [...sessions.values()].filter((s) => !s.exited && s.proc.pid)
  if (!live.length) return

  const byPid = new Map(live.map((s) => [s.proc.pid, s]))
  // -a ANDs the filters, -d cwd asks only for the cwd descriptor, -F gives
  // machine-readable output, -w silences warnings about unreadable pids.
  execFile(
    'lsof',
    ['-a', '-w', '-d', 'cwd', '-Fpn', '-p', [...byPid.keys()].join(',')],
    (_err, stdout) => {
      // lsof exits non-zero when *any* pid is gone; the output for the rest is
      // still good, so parse it regardless.
      if (!stdout) return
      let current: Session | undefined
      for (const line of stdout.split('\n')) {
        if (line.startsWith('p')) {
          current = byPid.get(Number(line.slice(1)))
        } else if (line.startsWith('n') && current) {
          const path = line.slice(1)
          // A transient miss must never blank a row.
          if (path && existsSync(path)) current.cwd = path
          current = undefined
        }
      }
    },
  )
}

/**
 * Latch which tabs are running Claude Code, by looking for a `claude` anywhere
 * beneath each tab's shell. One `ps` sweep covers every tab, so this costs a
 * single process spawn regardless of how many are open.
 */
function scanForClaude(): void {
  execFile('ps', ['-eo', 'pid=,ppid=,comm='], (err, stdout) => {
    if (err) return

    const children = new Map<number, number[]>()
    const named = new Map<number, string>()
    for (const line of stdout.split('\n')) {
      const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)
      if (!m) continue
      const [, pid, ppid, comm] = m
      const p = Number(pid)
      const parent = Number(ppid)
      named.set(p, (comm ?? '').trim())
      const arr = children.get(parent)
      if (arr) arr.push(p)
      else children.set(parent, [p])
    }

    for (const s of sessions.values()) {
      if (s.exited || s.sawClaude) continue
      const stack = [s.proc.pid]
      while (stack.length) {
        const pid = stack.pop()
        if (pid === undefined) break
        if (basename(named.get(pid) ?? '') === 'claude') {
          s.sawClaude = true
          break
        }
        const kids = children.get(pid)
        if (kids) stack.push(...kids)
      }
    }
  })
}

/** One timer for everything we have to learn about a session from the outside. */
function sweep(): void {
  scanForClaude()
  refreshCwds()
}

function startSessionSweep(): void {
  if (sessionSweep) return
  sweep()
  sessionSweep = setInterval(sweep, 3000)
}

/** Whether this tab is mid-conversation, and so worth resuming on next launch. */
export function usedClaude(id: string): boolean {
  return sessions.get(id)?.sawClaude ?? false
}

/** True when nothing but the login shell is in the foreground. */
function isBareShell(proc: string): boolean {
  return proc === '' || /^-?(zsh|bash|sh|fish)$/.test(proc)
}

/**
 * What the tab's dot should say. There is no API that reports "Claude is waiting
 * for you", so it is inferred: a foreground program that has gone quiet is one
 * that is blocked on input, and a program still writing is one still working.
 * A terminal bell (which Claude Code rings when it wants attention) short-cuts
 * straight to `waiting`, without having to wait out the quiet period.
 */
export function statusOf(id: string): TabStatus {
  const s = sessions.get(id)
  if (!s || s.exited) return 'exited'
  if (isBareShell(foregroundProcess(id))) return 'ready'
  if (s.belled) return 'waiting'
  // Claude goes quiet for seconds mid-turn — a tool call, a bash step, a network
  // wait — while still working. 900ms flipped those gaps to blue. The bell above
  // already catches a genuine "waiting on you" instantly, so the quiet window can
  // be generous without making true waiting laggy.
  return Date.now() - s.lastDataAt < 2500 ? 'working' : 'waiting'
}

export function cwdOf(id: string): string {
  return sessions.get(id)?.cwd ?? homedir()
}

/**
 * The Claude Code session id this tab's shim minted, or '' if `claude` has not
 * been run here (or was run through a shell alias that bypasses the shim).
 */
export function claudeSessionOf(id: string): string {
  try {
    return readFileSync(sessionIdFile(id), 'utf8').trim()
  } catch {
    return ''
  }
}

/**
 * Whether a conversation is still on disk and so actually resumable. Matched by
 * scanning the project folders for the id rather than recomputing Claude's cwd
 * slug, which would drift the moment its naming rules change — and the tab may
 * have `cd`ed since anyway.
 */
export function claudeSessionExists(sessionId: string): boolean {
  if (!/^[0-9a-f-]{36}$/i.test(sessionId)) return false
  const root = join(homedir(), '.claude', 'projects')
  try {
    for (const dir of readdirSync(root)) {
      if (existsSync(join(root, dir, `${sessionId}.jsonl`))) return true
    }
  } catch {
    /* no transcripts yet */
  }
  return false
}

/**
 * The conversations that exist for a folder, newest first.
 *
 * Restoring several tabs on one folder used to type `claude --continue` into
 * every one of them, and `--continue` means *the newest conversation here* — so
 * all of them landed on the same one and the rest were left behind, still on
 * disk, with nothing pointing at them. Handing out the nth id to the nth tab
 * puts them back on different conversations, and gives each tab a real id to
 * remember afterwards.
 */
export function recentClaudeSessions(cwd: string, limit: number): string[] {
  // Claude Code names the project folder after the cwd with every character
  // that isn't alphanumeric replaced by a dash.
  const slug = cwd.replace(/[^a-zA-Z0-9]/g, '-')
  const dir = join(homedir(), '.claude', 'projects', slug)
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => ({ id: f.slice(0, -6), at: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => b.at - a.at)
      .slice(0, limit)
      .map((f) => f.id)
  } catch {
    return []
  }
}

export function liveIds(): string[] {
  return [...sessions.keys()]
}
