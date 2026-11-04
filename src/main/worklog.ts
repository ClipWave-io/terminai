import { readdirSync, readFileSync, statSync, writeFileSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import type { WorkDay, WorkConversation } from '../shared/types'

/**
 * The work log: each day, what this person's Claude Code and Codex conversations on this Mac did, read from
 * their transcripts. Per conversation its title, folder, when it ran, how long it was active and every finished
 * turn's SPOKEN summary with the time it was announced. Never the prompts. The app sends each day to the
 * TerminAI server, where the partner, the website and the iPhone app read it.
 */
const HOME = homedir()
const GAP = 5 * 60_000                                       // a pause longer than this is not working time
const SECRET = /(sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|[A-Za-z0-9_-]{40,})/g

type Read = { tool: 'Claude' | 'Codex'; id: string; title: string; cwd: string; times: number[]; done: { at: number; text: string }[] }
const spoken = (text: unknown) => String(text ?? '').split('\n').filter(l => l.startsWith('SPOKEN:')).map(l => l.slice(7).trim()).pop()
const lines = (file: string) => { try { return readFileSync(file, 'utf8').split('\n') } catch { return [] } }
const parse = (line: string): any => { try { return JSON.parse(line) } catch { return null } }

function readClaude(file: string): Read {
  const r: Read = { tool: 'Claude', id: basename(file, '.jsonl'), title: '', cwd: '', times: [], done: [] }
  for (const line of lines(file)) {
    const d = parse(line); if (!d) continue
    if (d.type === 'ai-title') r.title = d.aiTitle || d.title || r.title
    if (d.type !== 'user' && d.type !== 'assistant') continue
    const at = Date.parse(d.timestamp); if (!at) continue
    r.cwd = d.cwd || r.cwd; r.times.push(at)
    if (d.type === 'assistant') for (const b of d.message?.content ?? []) { const s = b?.type === 'text' && spoken(b.text); if (s) r.done.push({ at, text: s }) }
  }
  return r
}
function readCodex(file: string): Read {
  const r: Read = { tool: 'Codex', id: basename(file, '.jsonl'), title: '', cwd: '', times: [], done: [] }
  for (const line of lines(file)) {
    const d = parse(line); if (!d) continue
    const p = d.payload ?? {}
    if (d.type === 'session_meta') { r.cwd = p.cwd ?? ''; continue }
    if (d.type !== 'response_item' || p.type !== 'message' || (p.role !== 'user' && p.role !== 'assistant')) continue
    const at = Date.parse(d.timestamp); if (!at) continue
    r.times.push(at)
    if (p.role === 'assistant') for (const b of p.content ?? []) { const s = spoken(b?.text); if (s) r.done.push({ at, text: s }) }
    else if (!r.title) { const t = (p.content ?? []).map((b: any) => b?.text ?? '').join(' ').trim(); if (t && !t.startsWith('<')) r.title = t.split('\n')[0].slice(0, 80) }
  }
  return r
}
function files(dir: string, deep: boolean, since: number): string[] {
  const out: string[] = []
  const walk = (d: string, depth: number) => {
    let names: string[] = []; try { names = readdirSync(d) } catch { return }
    for (const n of names) {
      const p = join(d, n)
      if (n.endsWith('.jsonl')) { try { if (statSync(p).mtimeMs >= since) out.push(p) } catch {} }
      else if (depth > 0 && !n.includes('.')) walk(p, depth - 1)
    }
  }
  walk(dir, deep ? 4 : 1)
  return out
}
const place = (cwd: string) => (cwd.startsWith(HOME) ? '~' + cwd.slice(HOME.length) : cwd)
  .replace(/^~\/other projects\/Claude and Codex Outputs\/Task Workspaces\//, 'workspace: ') || '~'
const local = (day: string) => { const [y, m, d] = day.split('-').map(Number); return new Date(y, m - 1, d).getTime() }
export const today = (at = new Date()) => `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`

/** Every conversation with activity that day, cut to the day. `skip`: folders left out of the log. */
function conversations(day: string, skip: string[] = []): Read[] {
  const start = local(day), end = start + 86400_000
  const found = [
    ...readdirSync(join(HOME, '.claude', 'projects'), { withFileTypes: true }).filter(e => e.isDirectory())
      .flatMap(e => files(join(HOME, '.claude', 'projects', e.name), false, start - 3600_000)).map(readClaude),
    ...files(join(HOME, '.codex', 'sessions'), true, start - 3600_000).map(readCodex),
  ]
  return found.map(r => ({ ...r, times: r.times.filter(t => t >= start && t < end).sort((a, b) => a - b), done: r.done.filter(x => x.at >= start && x.at < end) }))
    .filter(r => r.times.length && !skip.some(s => s && r.cwd.includes(s)))
}

/** Working time: the gaps between events added up, a pause longer than GAP counted as nothing. */
function spans(times: number[]): [number, number][] {
  const out: [number, number][] = []
  for (let i = 1; i < times.length; i++) if (times[i] - times[i - 1] <= GAP) out.push([times[i - 1], times[i]])
  return out
}
const length = (s: [number, number][]) => s.reduce((n, [a, b]) => n + b - a, 0)
function union(all: [number, number][]): number {
  let total = 0, cur: [number, number] | null = null
  for (const [a, b] of [...all].sort((x, y) => x[0] - y[0])) {
    if (cur && a <= cur[1]) cur[1] = Math.max(cur[1], b)
    else { if (cur) total += cur[1] - cur[0]; cur = [a, b] }
  }
  return cur ? total + cur[1] - cur[0] : total
}

export function workDay(day: string, person: string, skip: string[] = []): WorkDay {
  const rs = conversations(day, skip), all: [number, number][] = [], byPlace = new Map<string, number>()
  const list: WorkConversation[] = rs.sort((a, b) => a.times[0] - b.times[0]).map(r => {
    const s = spans(r.times); all.push(...s)
    const ms = length(s), where = place(r.cwd)
    byPlace.set(where, (byPlace.get(where) ?? 0) + ms)
    return { tool: r.tool, title: r.title || r.done[0]?.text.slice(0, 70) || 'Untitled', place: where, start: new Date(r.times[0]).toISOString(),
      end: new Date(r.times[r.times.length - 1]).toISOString(), activeMinutes: Math.round(ms / 60000),
      done: r.done.map(x => ({ at: new Date(x.at).toISOString(), text: x.text.replace(SECRET, '[hidden]') })) }
  })
  return { day, person, workingMinutes: Math.round(union(all) / 60000), conversations: list,
    projects: [...byPlace].map(([place, ms]) => ({ place, minutes: Math.round(ms / 60000) })).filter(p => p.minutes > 0).sort((a, b) => b.minutes - a.minutes),
    writtenAt: new Date().toISOString() }
}

/**
 * Finished work from the other conversations since the last hand-off, given to one conversation only, so it can
 * tick the To-do tasks it finished and add done ones for work that had none (`terminai log hook`, at a prompt).
 */
export function handoff(stateFile: string, session: string, every = 30 * 60_000): string[] {
  let state: { handed?: number } = {}
  try { state = JSON.parse(readFileSync(stateFile, 'utf8')) } catch {}
  const now = Date.now(), since = state.handed ?? now - 3600_000
  if (now - since < every) return []
  writeFileSync(`${stateFile}.tmp`, JSON.stringify({ handed: now })); renameSync(`${stateFile}.tmp`, stateFile)
  const clock = (at: number) => new Date(at).toTimeString().slice(0, 5)
  return conversations(today()).filter(r => r.id !== session)
    .flatMap(r => r.done.filter(x => x.at > since).map(x => ({ at: x.at, line: `${clock(x.at)} [${place(r.cwd)}] ${x.text.replace(SECRET, '[hidden]')}` })))
    .sort((a, b) => a.at - b.at).map(x => x.line).slice(-40)
}
