import { execFile } from 'node:child_process'
import * as ptys from './pty'

/**
 * Pause a chat by hand (right-click › Pause in the sidebar): everything running in the tab (Claude Code or Codex and what
 * they started) is stopped where it is, using no CPU, and continues exactly there on Resume. The tab's shell itself stays,
 * so TerminAI keeps working. Kept apart from MacGuard's own pauses, which it resumes by itself.
 */
const paused = new Map<string, string>() // tab id -> HH:MM when paused
const descendants = (root: number) => new Promise<number[]>(resolve => execFile('/bin/ps', ['-axo', 'pid=,ppid='], { timeout: 5000 }, (_e, out) => {
  const kids = new Map<number, number[]>()
  for (const line of String(out || '').split('\n')) { const m = /^\s*(\d+)\s+(\d+)/.exec(line); if (m) (kids.get(Number(m[2])) ?? kids.set(Number(m[2]), []).get(Number(m[2]))!).push(Number(m[1])) }
  const all: number[] = [], walk = (p: number) => { for (const c of kids.get(p) ?? []) { all.push(c); walk(c) } }
  walk(root); resolve(all)
}))
const signal = (pids: number[], sig: NodeJS.Signals) => { for (const p of pids) { try { process.kill(p, sig) } catch {} } }

export async function pauseTab(id: string): Promise<boolean> {
  const shell = ptys.pidOf(id); if (!shell) return false
  const pids = await descendants(shell); if (!pids.length) return false
  // Children first is fine for SIGSTOP: nothing can run in between.
  signal(pids, 'SIGSTOP'); paused.set(id, new Date().toTimeString().slice(0, 5)); return true
}
export async function resumeTab(id: string): Promise<boolean> {
  const shell = ptys.pidOf(id); paused.delete(id); if (!shell) return false
  signal(await descendants(shell), 'SIGCONT'); return true
}
export const pausedTabs = (): Record<string, string> => Object.fromEntries(paused)
/** A tab closed while paused: its processes get to run so they can end. */
export function forgetTab(id: string): void { if (paused.has(id)) void resumeTab(id) }
