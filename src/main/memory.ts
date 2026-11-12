import { app } from 'electron'
import { execFile } from 'node:child_process'
import { totalmem } from 'node:os'
import * as ptys from './pty'

/**
 * Memory: what each tab's processes (its shell, Claude Code or Codex, and everything they started) and TerminAI itself
 * use, and how pressed the Mac is. Settings shows it; when macOS reports memory pressure, a notice names the tabs to close
 * before something gets killed.
 */
export type MemoryReport = { at: string; totalMb: number; pressure: 'normal' | 'warning' | 'critical'; appMb: number; tabsMb: number; tabs: { id: string; mb: number; idle: boolean; asleep: boolean }[]
  /** the whole Mac: in use (apps, macOS itself, compressed), free, swap on disk, and the biggest other apps */
  usedMb: number; macosMb: number; compressedMb: number; swapMb: number; apps: { name: string; mb: number }[] }
const run = (cmd: string, args: string[]) => new Promise<string>(resolve => execFile(cmd, args, { timeout: 5000, maxBuffer: 8 << 20 }, (_e, out) => resolve(String(out || ''))))
export async function memoryReport(): Promise<MemoryReport> {
  const [ps, level, vm, swap] = await Promise.all([run('/bin/ps', ['-axo', 'pid=,ppid=,rss=,comm=']), run('/usr/sbin/sysctl', ['-n', 'kern.memorystatus_vm_pressure_level']), run('/usr/bin/vm_stat', []), run('/usr/sbin/sysctl', ['-n', 'vm.swapusage'])])
  const kids = new Map<number, number[]>(), rss = new Map<number, number>(), comm = new Map<number, string>()
  for (const line of ps.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*(.*)$/.exec(line); if (!m) continue
    const [pid, ppid, kb] = [Number(m[1]), Number(m[2]), Number(m[3])]
    rss.set(pid, kb); comm.set(pid, m[4]); (kids.get(ppid) ?? kids.set(ppid, []).get(ppid)!).push(pid)
  }
  const tree = (pid: number): number => { let kb = rss.get(pid) ?? 0; for (const c of kids.get(pid) ?? []) kb += tree(c); return kb }
  const tabs = ptys.liveIds().map(id => { const a = ptys.agentOf(id), st = ptys.statusOf(id)
    return { id, mb: Math.round(tree(ptys.pidOf(id) || 0) / 1024), idle: a.alive && st !== 'working' && st !== 'question', asleep: false } }).sort((a, b) => b.mb - a.mb)
  const appMb = Math.round(app.getAppMetrics().reduce((n, p) => n + (p.memory?.workingSetSize ?? 0), 0) / 1024)
  const n = Number(level.trim())
  // The Mac as macOS counts it (vm_stat pages): in use = app memory + wired (macOS itself) + compressed; the rest is free or cache.
  const page = Number(/page size of (\d+)/.exec(vm)?.[1] ?? 16384), pages = (k: string) => Number(new RegExp(`${k}:\\s+(\\d+)`).exec(vm)?.[1] ?? 0) * page / 1048576
  const wired = pages('Pages wired down'), compressed = pages('Pages occupied by compressor'), appMem = pages('Anonymous pages') - pages('Pages purgeable')
  const used = Math.round(Math.max(0, appMem) + wired + compressed)
  // Other apps by name, everything that is not TerminAI or its tabs, so the bar says who else holds memory.
  const ours = new Set<number>(); const mark = (pid: number) => { ours.add(pid); for (const c of kids.get(pid) ?? []) mark(c) }
  mark(process.pid); for (const id of ptys.liveIds()) mark(ptys.pidOf(id) || 0)
  const byApp = new Map<string, number>()
  for (const [pid, kb] of rss) { if (ours.has(pid)) continue; const c = comm.get(pid) ?? ''; const name = /\/([^/]+)\.app\//.exec(c)?.[1] ?? c.split('/').pop() ?? '?'; byApp.set(name, (byApp.get(name) ?? 0) + kb / 1024) }
  const apps = [...byApp].map(([name, mb]) => ({ name, mb: Math.round(mb) })).sort((a, b) => b.mb - a.mb).slice(0, 5)
  return { at: new Date().toISOString(), totalMb: Math.round(totalmem() / 1048576), pressure: n >= 4 ? 'critical' : n === 2 ? 'warning' : 'normal',
    appMb, tabsMb: tabs.reduce((s, t) => s + t.mb, 0), tabs, usedMb: used, macosMb: Math.round(wired), compressedMb: Math.round(compressed),
    swapMb: Math.round(Number(/used = ([\d.]+)M/.exec(swap)?.[1] ?? 0)), apps }
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
