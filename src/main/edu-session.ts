/**
 * ManyMotions for Education: one Claude Code or Codex transcript read into the session record an institution
 * receives (edu.ts sends it). Pure: no Electron, no network, so it is tested on fixtures.
 *
 * Read from the same transcripts as the work log (worklog.ts), but per session and with what provenance needs:
 * when, how long it was active, how many prompts and replies, which files were touched, and the conversation
 * itself only when the institution collects it (detail 'prompts' or 'full').
 */
import { basename } from 'node:path'

export type EduDetail = 'off' | 'summary' | 'prompts' | 'full'
export type EduTool = 'claude-code' | 'codex'
export interface EduTurn { at: string; role: 'user' | 'assistant'; text: string }
export interface EduSession {
  externalId: string; tool: EduTool; title: string; project: string; cwd: string
  startedAt: string; endedAt: string; activeMinutes: number; prompts: number; replies: number
  filesTouched: string[]; turns: EduTurn[]
}

const GAP = 5 * 60_000                       // a pause longer than this is not working time (same as the work log)
const MAX_TURN = 8_000
const parse = (line: string): any => { try { return JSON.parse(line) } catch { return null } }
const clean = (s: string) => s.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()

/** Active minutes: gaps between events added up, a pause longer than GAP counted as nothing. */
export function activeMinutes(times: number[]): number {
  const t = [...times].sort((a, b) => a - b); let ms = 0
  for (let i = 1; i < t.length; i++) if (t[i] - t[i - 1] <= GAP) ms += t[i] - t[i - 1]
  return Math.round(ms / 60_000)
}

/** Paths inside the project are kept relative; anything else keeps only its file name. */
export function relativeFile(file: string, cwd: string): string {
  if (!file) return ''
  if (cwd && file.startsWith(cwd.endsWith('/') ? cwd : cwd + '/')) return file.slice(cwd.length).replace(/^\/+/, '')
  return file.startsWith('/') ? basename(file) : file
}

function finish(tool: EduTool, id: string, title: string, cwd: string, times: number[], prompts: number, replies: number, files: Set<string>, turns: EduTurn[]): EduSession | null {
  if (!times.length || !prompts) return null
  times.sort((a, b) => a - b)
  return {
    externalId: `${tool}:${id}`.slice(0, 120), tool, cwd,
    title: (title || turns.find(t => t.role === 'user')?.text.split('\n')[0] || 'Untitled session').slice(0, 160),
    project: basename(cwd || '') || '',
    startedAt: new Date(times[0]).toISOString(), endedAt: new Date(times[times.length - 1]).toISOString(),
    activeMinutes: activeMinutes(times), prompts, replies,
    filesTouched: [...files].map(f => relativeFile(f, cwd)).filter(Boolean).slice(0, 200), turns,
  }
}

/** A Claude Code transcript (~/.claude/projects/<folder>/<id>.jsonl). */
export function readClaudeSession(id: string, lines: string[]): EduSession | null {
  let title = '', cwd = '', prompts = 0, replies = 0
  const times: number[] = [], files = new Set<string>(), turns: EduTurn[] = []
  for (const line of lines) {
    const d = parse(line); if (!d) continue
    if (d.type === 'ai-title' || d.type === 'summary') { title = d.aiTitle || d.title || d.summary || title; continue }
    if (d.type !== 'user' && d.type !== 'assistant') continue
    if (d.isSidechain || d.isMeta) continue
    const at = Date.parse(d.timestamp); if (!at) continue
    cwd = d.cwd || cwd; times.push(at)
    const content = d.message?.content
    if (d.type === 'user') {
      // A prompt is text the person typed; tool results also arrive as "user" messages and are not prompts.
      const text = typeof content === 'string' ? content : Array.isArray(content) ? content.filter((b: any) => b?.type === 'text').map((b: any) => b.text).join('\n') : ''
      const t = clean(text)
      if (t && !t.startsWith('<command-') && !t.startsWith('<local-command') && !t.startsWith('Caveat:')) { prompts++; turns.push({ at: new Date(at).toISOString(), role: 'user', text: t.slice(0, MAX_TURN) }) }
      continue
    }
    let said = ''
    for (const b of Array.isArray(content) ? content : []) {
      if (b?.type === 'text' && b.text) said += (said ? '\n' : '') + b.text
      if (b?.type === 'tool_use') {
        const p = b.input?.file_path || b.input?.notebook_path || b.input?.path
        if (typeof p === 'string' && /^(Edit|Write|MultiEdit|NotebookEdit|Create|Update)$/i.test(b.name ?? '')) files.add(p)
      }
    }
    if (said.trim()) { replies++; turns.push({ at: new Date(at).toISOString(), role: 'assistant', text: clean(said).slice(0, MAX_TURN) }) }
  }
  return finish('claude-code', id, title, cwd, times, prompts, replies, files, turns)
}

/** Files a Codex apply_patch call adds, updates or deletes. */
export function patchFiles(patch: string): string[] {
  return [...patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map(m => m[1].trim())
}

/** A Codex transcript (~/.codex/sessions/YYYY/MM/DD/rollout-…jsonl). */
export function readCodexSession(id: string, lines: string[]): EduSession | null {
  let cwd = '', prompts = 0, replies = 0
  const times: number[] = [], files = new Set<string>(), turns: EduTurn[] = []
  for (const line of lines) {
    const d = parse(line); if (!d) continue
    const p = d.payload ?? {}
    if (d.type === 'session_meta') { cwd = p.cwd ?? cwd; continue }
    if (d.type === 'turn_context' && p.cwd) { cwd = p.cwd; continue }
    if (d.type !== 'response_item') continue
    const at = Date.parse(d.timestamp); if (!at) continue
    if (p.type === 'message' && (p.role === 'user' || p.role === 'assistant')) {
      const text = clean((p.content ?? []).map((b: any) => b?.text ?? '').join('\n'))
      if (!text || (p.role === 'user' && text.startsWith('<'))) continue    // environment and instruction blocks, not prompts
      times.push(at)
      if (p.role === 'user') prompts++; else replies++
      turns.push({ at: new Date(at).toISOString(), role: p.role, text: text.slice(0, MAX_TURN) })
    } else if (p.type === 'function_call' || p.type === 'custom_tool_call' || p.type === 'local_shell_call') {
      times.push(at)
      const raw = typeof p.arguments === 'string' ? p.arguments : typeof p.input === 'string' ? p.input : ''
      const args = parse(raw)
      const patch = typeof args?.input === 'string' ? args.input : Array.isArray(args?.command) ? args.command.join(' ') : raw
      if (/\*\*\* (Add|Update|Delete) File:/.test(patch)) for (const f of patchFiles(patch)) files.add(f.startsWith('/') ? f : (cwd ? `${cwd}/${f}` : f))
    }
  }
  return finish('codex', id, '', cwd, times, prompts, replies, files, turns)
}

/** Only what the institution collects leaves this Mac. */
export function forDetail(s: EduSession, detail: EduDetail): Omit<EduSession, 'cwd'> {
  const { cwd: _cwd, ...rest } = s
  return { ...rest, turns: detail === 'full' ? s.turns : detail === 'prompts' ? s.turns.filter(t => t.role === 'user') : [] }
}

/** Shared when its folder is one the student chose (that folder or any folder inside it). */
export const inFolders = (cwd: string, folders: string[]) => !!cwd && folders.some(f => f && (cwd === f || cwd.startsWith(f.endsWith('/') ? f : f + '/')))
/** A session is sent once it has been quiet for `quiet` (it may still be going otherwise); re-sent when it grows. */
export const isFinished = (lastActivity: number, now: number, quiet = 10 * 60_000) => now - lastActivity >= quiet
