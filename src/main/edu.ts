import { app, safeStorage } from 'electron'
import { readFile, writeFile, rename, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { forDetail, inFolders, isFinished, readClaudeSession, readCodexSession, type EduDetail, type EduSession } from './edu-session'

/**
 * ManyMotions for Education: a student connects TerminAI to their institution with a connection code
 * (Settings › Coding sessions on manymotions.org), picks the folders that count, and TerminAI then sends each
 * finished Claude Code or Codex session from those folders to the student's provenance record.
 *
 * Nothing is sent before the student connects and agrees, nothing from other folders, and only what the
 * institution collects (summary, prompts, or the full conversation). The code is kept encrypted in the
 * macOS keychain (safeStorage), never in a plain file. Sessions from before connecting are never sent.
 */
export interface EduSent { at: string; sessions: { title: string; project: string; tool: string; minutes: number }[] }
export interface EduStatus {
  connected: boolean; base: string; institution: string; member: string; detail: EduDetail; collects: string
  folders: string[]; since: string | null; lastSyncAt: string | null; lastError: string | null; history: EduSent[]
}
interface EduConfig { base: string; token: string; institution: string; member: string; detail: EduDetail; collects: string; folders: string[]; since: string; lastSyncAt: string | null; lastError: string | null; sent: Record<string, number>; history: EduSent[] }

const DEFAULT_BASE = 'https://manymotions.org'
const HOME = homedir()
const file = () => join(app.getPath('userData'), 'edu-sync.bin')
let cache: EduConfig | null | undefined
let running = false

async function load(): Promise<EduConfig | null> {
  if (cache !== undefined) return cache
  try {
    if (!safeStorage.isEncryptionAvailable()) return (cache = null)
    cache = JSON.parse(safeStorage.decryptString(await readFile(file()))) as EduConfig
  } catch { cache = null }
  return cache
}
async function save(c: EduConfig | null): Promise<void> {
  cache = c
  if (!c) { await writeFile(`${file()}.tmp`, Buffer.alloc(0)); await rename(`${file()}.tmp`, file()); return }
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Unlock your macOS keychain first.')
  await writeFile(`${file()}.tmp`, safeStorage.encryptString(JSON.stringify(c)), { mode: 0o600 }); await rename(`${file()}.tmp`, file())
}
const status = (c: EduConfig | null): EduStatus => c
  ? { connected: true, base: c.base, institution: c.institution, member: c.member, detail: c.detail, collects: c.collects, folders: c.folders, since: c.since, lastSyncAt: c.lastSyncAt, lastError: c.lastError, history: c.history.slice(0, 20) }
  : { connected: false, base: DEFAULT_BASE, institution: '', member: '', detail: 'off', collects: '', folders: [], since: null, lastSyncAt: null, lastError: null, history: [] }

export async function eduStatus(): Promise<EduStatus> { return status(await load()) }

const baseOf = (b: unknown) => {
  const s = typeof b === 'string' && b.trim() ? b.trim().replace(/\/+$/, '') : DEFAULT_BASE
  const u = new URL(s)
  // Only the real service, or a local development server.
  if (!(u.protocol === 'https:' || ((u.hostname === 'localhost' || u.hostname === '127.0.0.1') && u.protocol === 'http:'))) throw new Error('Use https://manymotions.org')
  return u.origin
}
async function policy(base: string, token: string): Promise<{ institution: string; member: string; detail: EduDetail; collects: string }> {
  const res = await fetch(`${base}/api/edu/coding-sessions/policy`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000) })
  const d = await res.json().catch(() => ({})) as any
  if (res.status === 401) throw new Error('This connection code does not work. Get a new one on manymotions.org › Settings › Coding sessions.')
  if (!res.ok) throw new Error(d.error || `ManyMotions answered ${res.status}`)
  return { institution: String(d.institution ?? ''), member: String(d.member ?? ''), detail: d.detail, collects: String(d.collects ?? '') }
}

/** Step 1: check a connection code and show what the institution would receive. Saves nothing. */
export async function eduCheck(code: unknown, base?: unknown): Promise<{ institution: string; member: string; detail: EduDetail; collects: string }> {
  const token = typeof code === 'string' ? code.trim() : ''
  if (!/^mm_tai_[A-Za-z0-9_-]{43}$/.test(token)) throw new Error('That is not a connection code. It starts with mm_tai_.')
  return policy(baseOf(base), token)
}

/** Step 2: the student agreed. Only sessions from now on, in these folders, are sent. */
export async function eduConnect(v: { code: unknown; base?: unknown; folders: unknown }): Promise<EduStatus> {
  const token = typeof v.code === 'string' ? v.code.trim() : ''
  const base = baseOf(v.base)
  const p = await eduCheck(token, base)
  if (p.detail === 'off') throw new Error(`${p.institution} does not accept coding sessions yet.`)
  const folders = (Array.isArray(v.folders) ? v.folders : []).filter((f): f is string => typeof f === 'string' && f.startsWith('/')).slice(0, 20)
  if (!folders.length) throw new Error('Choose at least one folder whose sessions count.')
  const c: EduConfig = { base, token, ...p, folders, since: new Date().toISOString(), lastSyncAt: null, lastError: null, sent: {}, history: [] }
  await save(c)
  return status(c)
}

export async function eduSetFolders(folders: unknown): Promise<EduStatus> {
  const c = await load(); if (!c) return status(null)
  c.folders = (Array.isArray(folders) ? folders : []).filter((f): f is string => typeof f === 'string' && f.startsWith('/')).slice(0, 20)
  await save(c); return status(c)
}

export async function eduDisconnect(): Promise<EduStatus> { await save(null); return status(null) }

/** Transcripts changed since `since` (Claude Code and Codex), newest activity last. */
async function transcripts(since: number): Promise<{ path: string; tool: 'claude' | 'codex'; mtime: number }[]> {
  const out: { path: string; tool: 'claude' | 'codex'; mtime: number }[] = []
  const walk = async (dir: string, depth: number, tool: 'claude' | 'codex'): Promise<void> => {
    let names: string[] = []; try { names = await readdir(dir) } catch { return }
    for (const n of names) {
      const p = join(dir, n)
      if (n.endsWith('.jsonl')) { try { const m = (await stat(p)).mtimeMs; if (m >= since) out.push({ path: p, tool, mtime: m }) } catch {} }
      else if (depth > 0 && !n.includes('.')) await walk(p, depth - 1, tool)
    }
  }
  await walk(join(HOME, '.claude', 'projects'), 1, 'claude')
  await walk(join(HOME, '.codex', 'sessions'), 4, 'codex')
  return out.sort((a, b) => a.mtime - b.mtime)
}

async function readSession(t: { path: string; tool: 'claude' | 'codex' }): Promise<EduSession | null> {
  const lines = (await readFile(t.path, 'utf8').catch(() => '')).split('\n')
  const id = basename(t.path, '.jsonl')
  return t.tool === 'claude' ? readClaudeSession(id, lines) : readCodexSession(id, lines)
}

/** Sessions that would be sent next, exactly as they would leave this Mac (for the consent view). */
export async function eduPreview(): Promise<ReturnType<typeof forDetail>[]> {
  const c = await load(); if (!c) return []
  return (await pending(c, Date.now(), true)).map(x => forDetail(x.session, c.detail)).slice(0, 20)
}

async function pending(c: EduConfig, now: number, includeOpen = false) {
  const since = Date.parse(c.since)
  const out: { key: string; mtime: number; session: EduSession }[] = []
  for (const t of await transcripts(since)) {
    if ((c.sent[t.path] ?? 0) >= t.mtime) continue
    if (!includeOpen && !isFinished(t.mtime, now)) continue
    const s = await readSession(t)
    if (!s || !inFolders(s.cwd, c.folders) || Date.parse(s.endedAt) < since) continue
    out.push({ key: t.path, mtime: t.mtime, session: s })
  }
  return out
}

/** Sends every finished, not yet sent session from the chosen folders. Runs every few minutes and on demand. */
export async function eduSync(now = Date.now()): Promise<EduStatus> {
  const c = await load(); if (!c || running) return status(c)
  running = true
  try {
    const todo = await pending(c, now)
    for (let i = 0; i < todo.length; i += 20) {
      const batch = todo.slice(i, i + 20)
      const res = await fetch(`${c.base}/api/edu/coding-sessions/ingest`, {
        method: 'POST', headers: { Authorization: `Bearer ${c.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessions: batch.map(x => forDetail(x.session, c.detail)) }), signal: AbortSignal.timeout(60_000),
      })
      const d = await res.json().catch(() => ({})) as any
      if (!res.ok) {
        c.lastError = res.status === 401 ? 'The connection code stopped working. Connect again with a new code.' : d.error === 'coding_sessions_off' ? `${c.institution} switched coding sessions off.` : (d.error || `ManyMotions answered ${res.status}`)
        await save(c); return status(c)
      }
      if (d.detail && d.detail !== c.detail) c.detail = d.detail
      for (const x of batch) c.sent[x.key] = x.mtime
      c.history.unshift({ at: new Date().toISOString(), sessions: batch.map(x => ({ title: x.session.title, project: x.session.project, tool: x.session.tool, minutes: x.session.activeMinutes })) })
      c.history = c.history.slice(0, 50)
    }
    c.lastSyncAt = new Date().toISOString(); c.lastError = null
    // Forget files that have not changed in 180 days so the list stays small.
    const old = now - 180 * 86_400_000
    for (const [k, m] of Object.entries(c.sent)) if (m < old) delete c.sent[k]
    await save(c)
    return status(c)
  } catch (e: any) {
    c.lastError = e?.message ?? String(e); await save(c).catch(() => {}); return status(c)
  } finally { running = false }
}

/** Every 5 minutes while the app runs (a no-op until a student connects). */
export function startEduSync(): void {
  if (process.env.TERMINAI_TEST_BUILD) return
  setTimeout(() => void eduSync(), 60_000)
  setInterval(() => void eduSync(), 5 * 60_000)
}
