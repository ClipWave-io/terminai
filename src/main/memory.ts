import { app } from 'electron'
import { execFile } from 'node:child_process'
import { totalmem } from 'node:os'
import * as ptys from './pty'

/**
 * Memory: what each tab's processes (its shell, Claude Code or Codex, and everything they started) and TerminAI itself
 * use, and how pressed the Mac is. Settings shows it; when macOS reports memory pressure, a notice names the tabs to close
 * before something gets killed.
 */
export type MemoryReport = { at: string; totalMb: number; pressure: 'normal' | 'warning' | 'critical'; appMb: number; tabsMb: number; tabs: { id: string; mb: number; idle: boolean; asleep: boolean }[] }
const run = (cmd: string, args: string[]) => new Promise<string>(resolve => execFile(cmd, args, { timeout: 5000, maxBuffer: 8 << 20 }, (_e, out) => resolve(String(out || ''))))
export async function memoryReport(): Promise<MemoryReport> {
  const [ps, level] = await Promise.all([run('/bin/ps', ['-axo', 'pid=,ppid=,rss=']), run('/usr/sbin/sysctl', ['-n', 'kern.memorystatus_vm_pressure_level'])])
  const kids = new Map<number, number[]>(), rss = new Map<number, number>()
  for (const line of ps.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)/.exec(line); if (!m) continue
    const [pid, ppid, kb] = [Number(m[1]), Number(m[2]), Number(m[3])]
    rss.set(pid, kb); (kids.get(ppid) ?? kids.set(ppid, []).get(ppid)!).push(pid)
  }
  const tree = (pid: number): number => { let kb = rss.get(pid) ?? 0; for (const c of kids.get(pid) ?? []) kb += tree(c); return kb }
  const tabs = ptys.liveIds().map(id => { const a = ptys.agentOf(id), st = ptys.statusOf(id)
    return { id, mb: Math.round(tree(ptys.pidOf(id) || 0) / 1024), idle: a.alive && st !== 'working' && st !== 'question', asleep: asleep.has(id) && !a.alive } }).sort((a, b) => b.mb - a.mb)
  const appMb = Math.round(app.getAppMetrics().reduce((n, p) => n + (p.memory?.workingSetSize ?? 0), 0) / 1024)
  const n = Number(level.trim())
  return { at: new Date().toISOString(), totalMb: Math.round(totalmem() / 1048576), pressure: n >= 4 ? 'critical' : n === 2 ? 'warning' : 'normal',
    appMb, tabsMb: tabs.reduce((s, t) => s + t.mb, 0), tabs }
}

/** Every minute; a notice when pressure rises, again at most every 20 minutes while it stays high. */
export function watchMemory(warn: (report: MemoryReport) => void): void {
  let last = 0, lastLevel: MemoryReport['pressure'] = 'normal'
  setInterval(() => void memoryReport().then(r => {
    const worse = r.pressure !== 'normal' && (r.pressure !== lastLevel || Date.now() - last > 20 * 60_000)
    lastLevel = r.pressure
    if (worse) { last = Date.now(); warn(r) }
  }).catch(() => {}), 60_000)
}

/**
 * Sleep: an idle Claude Code or Codex in a tab is closed (it holds its memory while it waits for you); the tab keeps
 * the conversation, and opening it brings the conversation back where it was (wake).
 */
const asleep = new Set<string>()
export function sleep(ids: string[]): number {
  let n = 0
  for (const id of ids) {
    const a = ptys.agentOf(id), st = ptys.statusOf(id)
    if (!a.alive || st === 'working' || st === 'question') continue
    ptys.write(id, '\x15'); ptys.write(id, a.kind === 'codex' ? '/quit\r' : '/exit\r'); asleep.add(id); n++
  }
  return n
}
export async function wake(id: string): Promise<boolean> {
  // Only tabs put to sleep here: a Claude Code someone quit on purpose stays quit.
  const a = ptys.agentOf(id)
  if (!asleep.has(id) || !a.kind || a.alive || !ptys.atShellPrompt(id)) return false
  asleep.delete(id)
  ptys.execWhenReady(id, await ptys.resumeCommandFor({ kind: a.kind, sessionId: a.sessionId, args: a.args, cwd: ptys.cwdOf(id) }))
  return true
}
