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

const pausedOf = (st: any): GuardState['paused'] => Array.isArray(st.paused) ? st.paused.map((p: any) => ({ id: String(p?.id ?? ''), name: String(p?.name ?? ''), at: String(p?.at ?? '') })).filter((p: { id: string }) => p.id) : []

export async function guardState(): Promise<GuardState | null> {
  let st: any
  try { st = JSON.parse(await readFile(join(HOME, 'state.json'), 'utf8')) } catch { return null }
  // The same freshness rule as `macguard status`: older than three samples and 10 s, the guardian is not running.
  const running = Date.now() / 1000 - Number(st.epoch ?? 0) <= 3 * Number(st.interval_s ?? 5) + 10
  return { running, level: Number(st.level ?? 0), paused: pausedOf(st) }
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

export type GuardDetails = GuardState & { at: string; sample: Record<string, number>; limits: Record<string, number>; events: { at: string; text: string }[] }
// MacGuard's own defaults (macguard.py DEFAULTS) for the limits shown; its config.json overrides them.
const LIMITS: Record<string, number> = { disk_warn_gb: 10, disk_crit_gb: 4, compressor_warn_gb: 6.5, compressor_crit_gb: 9.5, memlevel_warn: 25, memlevel_crit: 12,
  swap_warn_gb: 6, load_warn_per_cpu: 4, gpu_warn_pct: 95, gate_disk_gb: 7, gate_memlevel: 20, gate_compressor_gb: 8, gate_max_sessions: 17, resume_hold_s: 600 }
const LEVEL: Record<string, string> = { ok: 'OK', attenzione: 'Warning', critico: 'Critical' }
/** MacGuard's event log is in Italian (it is Livio's own tool); the panel shows it in the app's English. */
function englishEvent(text: string): string | null {
  const t = text.replace(/^\[DRY\] /, ''); let m: RegExpMatchArray | null
  if (t.startsWith('notifica')) return null
  if ((m = t.match(/^PAUSA (.+) \((\d+) processi, ([\d.]+) GB\)/))) return `Paused “${m[1]}” (${m[3]} GB)`
  if ((m = t.match(/^RIPRESA (.+)/))) return `Resumed “${m[1]}”`
  if ((m = t.match(/^livello (\w+) -> (\w+)/))) return `Level ${LEVEL[m[1]] ?? m[1]} → ${LEVEL[m[2]] ?? m[2]}`
  if ((m = t.match(/^CHIUSO (.+) \(pid \d+, ([\d.]+) GB\)/))) return `Closed ${m[1]} (${m[2]} GB): a runaway history search`
  if ((m = t.match(/^scheda chiusa durante la pausa: (.+?), /))) return `Tab “${m[1]}” closed while paused`
  if ((m = t.match(/^errore: (.+)/))) return `Error: ${m[1]}`
  return t
}
const day = (at: Date) => `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`

/** What the MacGuard panel shows: readings, limits and the last events of today and yesterday, newest first. */
export async function guardDetails(): Promise<GuardDetails | null> {
  let st: any
  try { st = JSON.parse(await readFile(join(HOME, 'state.json'), 'utf8')) } catch { return null }
  let cfg: Record<string, unknown> = {}
  try { cfg = JSON.parse(await readFile(join(HOME, 'config.json'), 'utf8')) } catch {}
  const limits = Object.fromEntries(Object.entries(LIMITS).map(([k, v]) => [k, typeof cfg[k] === 'number' ? cfg[k] as number : v]))
  const events: { at: string; text: string }[] = []
  for (const d of [day(new Date(Date.now() - 86400_000)), day(new Date())]) {
    let lines: string[] = []
    try { lines = (await readFile(join(HOME, 'log', `eventi-${d}.log`), 'utf8')).split('\n') } catch {}
    for (const l of lines) { const m = l.match(/^(\d\d:\d\d:\d\d) (.*)$/); const text = m && englishEvent(m[2]); if (m && text) events.push({ at: `${d.slice(5).split('-').reverse().join('/')} ${m[1].slice(0, 5)}`, text }) }
  }
  const running = Date.now() / 1000 - Number(st.epoch ?? 0) <= 3 * Number(st.interval_s ?? 5) + 10
  return { running, level: Number(st.level ?? 0), paused: pausedOf(st), at: String(st.ora ?? '').slice(11, 19), sample: st.campione ?? {}, limits, events: events.slice(-25).reverse() }
}

/** Restarts the guardian's LaunchAgent (it reads its paused list back from state.json). */
export function restartGuard(): Promise<void> {
  return new Promise((resolve, reject) => execFile('/bin/launchctl', ['kickstart', '-k', `gui/${process.getuid?.() ?? 501}/com.livio.macguard`], { timeout: 15_000 },
    (err, _out, stderr) => err ? reject(new Error(String(stderr).trim() || String(err.message))) : resolve()))
}
