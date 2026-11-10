import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * MacGuard, this Mac's memory guardian (~/Library/Application Support/MacGuard, LaunchAgent com.livio.macguard): when
 * the Mac is about to freeze it pauses whole sessions (SIGSTOP on the tab's processes) and lists them in its state.json,
 * by TerminAI tab id. TerminAI shows which chats are paused and resumes one through it (`macguard resume <id>`), so the
 * guardian's own list stays true. Without MacGuard installed there is no state file and nothing shows.
 */
const INSTALL = join(homedir(), 'Library', 'Application Support', 'MacGuard')
// Where its state lives; tests point it at a scratch folder. The script itself is always the installed one.
const HOME = process.env.TERMINAI_MACGUARD_HOME || INSTALL

export type GuardState = { running: boolean; level: number; paused: { id: string; name: string; at: string }[] }

export async function guardState(): Promise<GuardState | null> {
  let st: any
  try { st = JSON.parse(await readFile(join(HOME, 'state.json'), 'utf8')) } catch { return null }
  // The same freshness rule as `macguard status`: older than three samples and 10 s, the guardian is not running.
  const running = Date.now() / 1000 - Number(st.epoch ?? 0) <= 3 * Number(st.interval_s ?? 5) + 10
  const paused = Array.isArray(st.paused) ? st.paused.map((p: any) => ({ id: String(p?.id ?? ''), name: String(p?.name ?? ''), at: String(p?.at ?? '') })).filter((p: { id: string }) => p.id) : []
  return { running, level: Number(st.level ?? 0), paused }
}

/** Resumes these tabs (none: every paused one). Waits for the guardian to do it, at most about 15 s. */
export function resumeGuard(ids: string[]): Promise<void> {
  const ok = ids.filter(id => /^[A-Za-z0-9_-]{1,120}$/.test(id))
  return new Promise((resolve, reject) => execFile('/usr/bin/python3', ['-I', join(INSTALL, 'macguard.py'), '--home', HOME, 'resume', ...ok], { timeout: 30_000 },
    (err, _out, stderr) => err ? reject(new Error(String(stderr).trim().split('\n').pop() || `macguard exited with ${err.code ?? err.signal}`)) : resolve()))
}

/** Every 3 s: `onChange` with the new state when it changed, `onPaused` for each tab the guardian has just paused. */
export function watchGuard(onChange: (s: GuardState | null) => void, onPaused: (p: { id: string; name: string; at: string }) => void): void {
  let last = '', known: Set<string> | null = null
  setInterval(() => void guardState().then(s => {
    const key = JSON.stringify(s)
    if (key === last) return
    last = key; onChange(s)
    const now = new Set(s?.paused.map(p => p.id) ?? [])
    // The first read only learns what was already paused (a restart must not notify again).
    if (known) for (const p of s?.paused ?? []) if (!known.has(p.id)) onPaused(p)
    known = now
  }), 3000)
}
