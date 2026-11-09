import { execFile } from 'node:child_process'
import { homedir, userInfo } from 'node:os'
import { join } from 'node:path'

/**
 * Settings › Memory, in detail: every app and macOS itself with what it really holds (top's footprint, which counts the
 * part macOS compressed or wrote to disk, unlike ps), each one's biggest processes, a look inside one process and a way
 * to stop it; and the disk: what is used and which folders hold it.
 */
const run = (cmd: string, args: string[], timeout = 8000) => new Promise<string>(resolve =>
  execFile(cmd, args, { timeout, maxBuffer: 32 << 20 }, (_e, out) => resolve(String(out || ''))))
const SYSTEM = /^\/(System|usr|sbin|bin|Library\/Apple|private\/var\/run\/com\.apple)/
const TOOLS: [RegExp, string][] = [[/(^|\/)(node|npm|npx|bun|deno)$|\/\.npm\/_npx\/|mcp/, 'Node (connectors, servers)'], [/[Pp]ython[\d.]*$/, 'Python'], [/(^|\/)(claude|claude\.exe)$/, 'Claude Code'], [/codex/, 'Codex']]

export type MemProc = { pid: number; name: string; mb: number }
export type MemGroup = { name: string; kind: 'macos' | 'app' | 'tool'; mb: number; count: number; procs: MemProc[] }
export type MemoryDetail = { at: string; wiredMb: number; groups: MemGroup[] }

export async function memoryDetail(): Promise<MemoryDetail> {
  const [top, ps, vm] = await Promise.all([run('/usr/bin/top', ['-l', '1', '-o', 'mem', '-stats', 'pid,mem', '-n', '5000'], 15000),
    run('/bin/ps', ['-axo', 'pid=,comm=']), run('/usr/bin/vm_stat', [])])
  const path = new Map<number, string>()
  for (const l of ps.split('\n')) { const m = /^\s*(\d+)\s+(.*)$/.exec(l); if (m) path.set(Number(m[1]), m[2]) }
  const groups = new Map<string, MemGroup>()
  for (const l of top.split('\n')) {
    const m = /^\s*(\d+)\s+([\d.]+)([KMGB])[+-]?\s*$/.exec(l); if (!m) continue
    const pid = Number(m[1]), mb = Number(m[2]) * ({ B: 1 / 1048576, K: 1 / 1024, M: 1, G: 1024 } as Record<string, number>)[m[3]]
    const p = path.get(pid) ?? '', base = p.split('/').pop() || `pid ${pid}`
    const bundle = /\/([^/]+)\.app\//.exec(p)?.[1]
    const tool = TOOLS.find(([rx]) => rx.test(p))?.[1]
    const [name, kind]: [string, MemGroup['kind']] = pid === 0 ? ['macOS', 'macos'] : tool ? [tool, 'tool']
      : bundle && (!SYSTEM.test(p) || p.startsWith('/System/Applications/')) ? [bundle, 'app'] : SYSTEM.test(p) ? ['macOS', 'macos'] : [bundle ?? base, 'app']
    const g = groups.get(name) ?? groups.set(name, { name, kind, mb: 0, count: 0, procs: [] }).get(name)!
    g.mb += mb; g.count++; g.procs.push({ pid, name: pid === 0 ? 'kernel' : bundle && base !== bundle ? `${bundle} · ${base}` : base, mb: Math.round(mb) })
  }
  const page = Number(/page size of (\d+)/.exec(vm)?.[1] ?? 16384)
  const wiredMb = Math.round(Number(/Pages wired down:\s+(\d+)/.exec(vm)?.[1] ?? 0) * page / 1048576)
  const list = [...groups.values()].map(g => ({ ...g, mb: Math.round(g.mb), procs: g.procs.sort((a, b) => b.mb - a.mb).slice(0, 25) }))
    .sort((a, b) => b.mb - a.mb)
  return { at: new Date().toISOString(), wiredMb, groups: list }
}

export type ProcInfo = { pid: number; ok: boolean; command: string; user: string; started: string; cpu: string; mb: number
  parents: string[]; cwd: string; ports: string[]; stoppable: boolean; why?: string }

/** One process up close: what it is, who started it, where it runs, what it listens on, and whether it may be stopped. */
export async function processInfo(pid: number): Promise<ProcInfo> {
  const line = (await run('/bin/ps', ['-o', 'user=,lstart=,%cpu=,rss=,ppid=,command=', '-p', String(pid)])).trim()
  const m = /^(\S+)\s+(\w+\s+\w+\s+\d+\s+[\d:]+\s+\d+)\s+([\d.]+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line)
  if (!m) return { pid, ok: false, command: '', user: '', started: '', cpu: '', mb: 0, parents: [], cwd: '', ports: [], stoppable: false, why: 'It has already quit.' }
  const parents: string[] = []
  for (let pp = Number(m[5]), n = 0; pp > 1 && n < 6; n++) {
    const p = (await run('/bin/ps', ['-o', 'ppid=,comm=', '-p', String(pp)])).trim(); const q = /^(\d+)\s+(.*)$/.exec(p); if (!q) break
    parents.push(`${pp} ${q[2].split('/').pop()}`); pp = Number(q[1])
  }
  const [cwd, net] = await Promise.all([run('/usr/sbin/lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn']), run('/usr/sbin/lsof', ['-a', '-p', String(pid), '-iTCP', '-sTCP:LISTEN', '-P', '-n', '-Fn'])])
  const exe = m[6].split(' ')[0]
  const why = m[1] !== userInfo().username ? 'It belongs to macOS or another user.' : pid === process.pid ? 'It is TerminAI itself.'
    : SYSTEM.test(exe) ? 'It is part of macOS; macOS restarts it.' : undefined
  return { pid, ok: true, command: m[6], user: m[1], started: m[2], cpu: m[3], mb: Math.round(Number(m[4]) / 1024), parents,
    cwd: cwd.split('\n').find(l => l.startsWith('n'))?.slice(1) ?? '', ports: net.split('\n').filter(l => l.startsWith('n')).map(l => l.slice(1)),
    stoppable: !why, why }
}

/** Stop asks the process to quit (SIGTERM); force ends it at once (SIGKILL). Only the user's own, never macOS or TerminAI. */
export async function stopProcess(pid: number, force: boolean): Promise<string> {
  const info = await processInfo(pid)
  if (!info.ok) return 'It has already quit.'
  if (!info.stoppable) return `Not stopped: ${info.why}`
  try { process.kill(pid, force ? 'SIGKILL' : 'SIGTERM') } catch (e) { return `Could not stop it: ${(e as Error).message}` }
  await new Promise(r => setTimeout(r, 1200))
  try { process.kill(pid, 0); return force ? 'Still running.' : 'Asked it to quit; it is still running. Use Force stop.' } catch { return 'Stopped.' }
}

export type StorageReport = { at: string; totalGb: number; usedGb: number; freeGb: number; folders: { name: string; path: string; gb: number }[] }

/** The disk: used and free on the startup volume, then the usual big folders (du can take a minute on a full disk). */
export async function storageReport(): Promise<StorageReport> {
  const df = (await run('/bin/df', ['-k', '/System/Volumes/Data'])).split('\n')[1]?.trim().split(/\s+/) ?? []
  const [total, used, free] = [1, 2, 3].map(i => Number(df[i] ?? 0) / 1048576)
  const h = homedir()
  const spots: [string, string][] = [['Downloads', 'Downloads'], ['Desktop', 'Desktop'], ['Documents', 'Documents'], ['Movies', 'Movies'], ['Pictures', 'Pictures'],
    ['Music', 'Music'], ['App caches', 'Library/Caches'], ['App data', 'Library/Application Support'], ['App containers', 'Library/Containers'],
    ['Xcode and simulators', 'Library/Developer'], ['iCloud Drive (local)', 'Library/Mobile Documents'], ['Mail', 'Library/Mail'], ['Messages', 'Library/Messages'],
    ['Trash', '.Trash'], ['npm cache', '.npm'], ['Other caches (~/.cache)', '.cache'], ['Code projects (Clipwave)', 'Clipwave'], ['Other projects', 'other projects']]
  const folders = await Promise.all(spots.map(async ([name, rel]) => {
    const out = await run('/usr/bin/du', ['-sk', join(h, rel)], 120000)
    return { name, path: join(h, rel), gb: Number(/^(\d+)/.exec(out)?.[1] ?? 0) / 1048576 }
  }))
  return { at: new Date().toISOString(), totalGb: total, usedGb: used, freeGb: free, folders: folders.filter(f => f.gb >= 0.05).sort((a, b) => b.gb - a.gb) }
}
