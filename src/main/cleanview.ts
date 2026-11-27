import { stat } from 'node:fs/promises'
import * as ptys from './pty'
import { cursor, readAppended, type Cursor } from './transcripts'

/**
 * The Clean view of a Claude Code or Codex tab: its transcript as a chat, only the person's messages and the agent's
 * text (no tool calls, no tool output). Read incrementally per transcript file, like the sharing bridge does.
 */
export type CleanItem = { role: 'user' | 'assistant' | 'note'; text: string; end?: boolean; images?: string[] }

/** Pictures the person sent with a message, small enough to show (data URLs; at most 4, each under 4 MB). */
function imagesOf(content: unknown): string[] {
  if (!Array.isArray(content)) return []
  return content.filter((b: any) => b?.type === 'image' && b.source?.type === 'base64' && typeof b.source.data === 'string' && b.source.data.length < 4_000_000)
    .slice(0, 4).map((b: any) => `data:${b.source.media_type || 'image/png'};base64,${b.source.data}`)
}

/**
 * What TerminAI and Claude Code put into a user message, turned into something readable: a sender for messages from
 * other agents and sessions (their header with ids and instructions goes), pasted blocks as quotes, shell commands as
 * code; the rest of the bookkeeping becomes a one-line note or nothing.
 */
function tidyUser(text: string): { note?: string; text: string } | null {
  const t = text.trim()
  if (/^This session is being continued from a previous conversation/i.test(t)) return { note: 'Earlier part of the conversation summarized', text: '' }
  if (/^\[Request interrupted/i.test(t)) return { note: 'Interrupted', text: '' }
  const cmd = /<command-name>\/?([^<]+)<\/command-name>/.exec(t)
  if (cmd) return /^(exit|clear)$/i.test(cmd[1].trim()) ? null : { note: `/${cmd[1].trim()}`, text: '' }
  if (/^<local-command-(stdout|stderr)>/.test(t) || /^<(system-reminder|environment_context|user_instructions|permissions|user-prompt-submit-hook)/.test(t) || /^Caveat: /.test(t) || /^# AGENTS\.md/.test(t)) return null
  // TerminAI's message headers and pasted blocks are laid out by the view (CleanView.tsx UserText).
  let out = t
  // A shell command run with ! and its output.
  out = out.replace(/<bash-input>([\s\S]*?)<\/bash-input>/g, (_m, c: string) => '`$ ' + c.trim() + '`').replace(/<bash-(stdout|stderr)>([\s\S]*?)<\/bash-\1>/g, (_m, _k, o: string) => o.trim() ? '```\n' + o.trim().slice(0, 4000) + '\n```' : '')
  // [Image #3] markers: the pictures themselves show above the text.
  out = out.replace(/\[Image #\d+\]\s*/g, '')
  return { text: out }
}
let versions = 0
const cache = new Map<string, { cur: Cursor; items: CleanItem[]; version: number }>()


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
  // A background task reporting back (<task-notification>…): one short line, "Task · what · status", not the raw block.
  if (role === 'user' && /^\s*<task-notification>/.test(text)) {
    const tag = (n: string) => new RegExp(`<${n}>([\\s\\S]*?)</${n}>`).exec(text)?.[1]?.trim() ?? ''
    const what = tag('summary').replace(/^(Monitor|Background (shell )?command|Agent)\s*/i, '').replace(/^"(.*)"\s*/, '$1 ').replace(/\s*(stream ended|completed|finished)$/i, '').trim() || 'Background task'
    items.push({ role: 'note', text: `${what}${tag('status') ? ` · ${tag('status')}` : ''}` })
    return
  }
  let images: string[] | undefined
  if (role === 'user') {
    const raw = d.type === 'user' ? d.message?.content : undefined
    const pics = imagesOf(raw); if (pics.length) images = pics
    const tidy = tidyUser(text)
    if (!tidy) return
    if (tidy.note) { items.push({ role: 'note', text: tidy.note }); return }
    text = tidy.text
    if (!text.trim() && !images) return
  }
  if (!role || (!text.trim() && !images)) return
  // A Codex answer comes twice (the event and the item): once is enough.
  const last = items[items.length - 1]
  if (last && last.role === role && last.text === text) return
  items.push({ role, text: text.replace(/\n{3,}/g, '\n\n').trim(), ...(images ? { images } : {}) })
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
