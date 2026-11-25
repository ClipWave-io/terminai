import { stat } from 'node:fs/promises'
import * as ptys from './pty'
import { cursor, readAppended, type Cursor } from './transcripts'

/**
 * The Clean view of a Claude Code or Codex tab: its transcript as a chat, only the person's messages and the agent's
 * text (no tool calls, no tool output). Read incrementally per transcript file, like the sharing bridge does.
 */
export type CleanItem = { role: 'user' | 'assistant'; text: string; end?: boolean }
let versions = 0
const cache = new Map<string, { cur: Cursor; items: CleanItem[]; version: number }>()

// What the agents write into the conversation themselves: commands, reminders, the environment they start with.
const NOISE = /^\s*(<command-|<local-command|<system-reminder|<environment_context|<user_instructions|<permissions|<user-prompt-submit-hook|Caveat: |# AGENTS\.md|\[Request interrupted)/

function textOf(content: unknown, kinds: string[]): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.filter((b: any) => b && kinds.includes(b.type) && typeof b.text === 'string').map((b: any) => b.text).join('\n\n')
}

/**
 * The short progress lines Claude Code shows during a turn ("· summary" in the terminal) are thinking blocks marked as
 * narration in their signature; other thinking stays hidden.
 */
function narration(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content.filter((b: any) => b?.type === 'thinking' && typeof b.thinking === 'string' && b.thinking.trim() && typeof b.signature === 'string'
    && Buffer.from(b.signature.slice(0, 200), 'base64').includes('narration')).map((b: any) => b.thinking.trim()).join('\n\n')
}

function parse(line: string, items: CleanItem[]): void {
  let d: any; try { d = JSON.parse(line) } catch { return }
  if (d.isSidechain || d.isMeta) return
  let role: 'user' | 'assistant' | null = null, text = ''
  if (d.type === 'user' && d.message?.role === 'user') { role = 'user'; text = textOf(d.message.content, ['text']) }
  else if (d.type === 'assistant') { role = 'assistant'; text = [narration(d.message?.content), textOf(d.message?.content, ['text'])].filter(Boolean).join('\n\n') }
  // A message typed while the agent was working, taken in between two steps of the turn.
  else if (d.type === 'attachment' && d.attachment?.type === 'queued_command' && typeof d.attachment.prompt === 'string' && d.attachment.commandMode !== 'bash') { role = 'user'; text = d.attachment.prompt }
  else if (d.type === 'response_item' && d.payload?.type === 'message' && (d.payload.role === 'user' || d.payload.role === 'assistant')) {
    role = d.payload.role; text = textOf(d.payload.content, ['input_text', 'output_text', 'text'])
  } else if ((d.type === 'system' && d.subtype === 'turn_duration') || (d.type === 'event_msg' && d.payload?.type === 'task_complete')) {
    const last = items[items.length - 1]; if (last) last.end = true
    return
  }
  if (!role || !text.trim() || (role === 'user' && NOISE.test(text))) return
  // A Codex answer comes twice (the event and the item): once is enough.
  const last = items[items.length - 1]
  if (last && last.role === role && last.text === text) return
  items.push({ role, text: text.replace(/\n{3,}/g, '\n\n').trim() })
}

/** The conversation so far; `seen` is the version the view already has: then only `{ version }` comes back. */
export async function readClean(tabId: string, transcript: (id: string) => string, seen = -1): Promise<{ file: boolean; version: number; items?: CleanItem[] }> {
  const file = transcript(tabId)
  if (!file) return { file: false, version: 0, items: [] }
  try { await stat(file) } catch { return { file: false, version: 0, items: [] } }
  let entry = cache.get(file)
  if (!entry) { entry = { cur: cursor(), items: [], version: ++versions }; cache.set(file, entry) }
  const e = entry, before = e.cur.at
  await readAppended(file, e.cur, line => parse(line, e.items), () => { e.items = [] })
  // One counter for every file: when a tab's transcript changes (a conversation moved folders), the view always reloads.
  if (e.cur.at !== before) e.version = ++versions
  // Long conversations: the newest 400 messages are plenty for a view.
  if (e.items.length > 600) e.items = e.items.slice(-400)
  return seen === e.version ? { file: true, version: e.version } : { file: true, version: e.version, items: e.items }
}

/** Typed into the tab the way `terminai send` does: pasted, then Enter on its own once it is in. */
export async function sendClean(tabId: string, text: string): Promise<void> {
  const clean = text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '')
  if (!clean.trim()) return
  ptys.write(tabId, `\x1b[200~${clean}\x1b[201~`)
  await Promise.race([ptys.written(tabId), new Promise(r => setTimeout(r, 20_000))])
  await new Promise(r => setTimeout(r, 150))
  ptys.write(tabId, '\r')
}
