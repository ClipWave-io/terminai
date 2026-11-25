import { cursor, readAppended, type Cursor } from './transcripts'

/**
 * Sub-agents still working in the background of a Claude Code conversation: launched ("Async agent launched") and not
 * yet reported back by a <task-notification> for the same tool use. While any are, the tab shows as working (orange),
 * even though the conversation itself waits at its prompt. Read incrementally, a few times a second at most.
 */
const STALE_MS = 3 * 60 * 60 * 1000
const files = new Map<string, { cur: Cursor; pending: Map<string, number>; checked: number }>()

function scan(line: string, pending: Map<string, number>): void {
  if (!line.includes('Async agent launched') && !line.includes('task-notification')) return
  let d: any; try { d = JSON.parse(line) } catch { return }
  if (d.type !== 'user' || d.isSidechain) return
  const content = d.message?.content
  const at = Date.parse(d.timestamp ?? '') || Date.now()
  if (Array.isArray(content)) for (const b of content) {
    if (b?.type !== 'tool_result' || typeof b.tool_use_id !== 'string') continue
    const text = typeof b.content === 'string' ? b.content : Array.isArray(b.content) ? b.content.map((x: any) => x?.text ?? '').join(' ') : ''
    if (text.startsWith('Async agent launched')) pending.set(b.tool_use_id, at)
  }
  const text = typeof content === 'string' ? content : Array.isArray(content) ? content.map((x: any) => x?.text ?? '').join(' ') : ''
  for (const m of text.matchAll(/<tool-use-id>([^<]+)<\/tool-use-id>/g)) pending.delete(m[1])
}

/** How many sub-agents of this transcript are still running (from what was read so far; it reads more in the background). */
export function backgroundAgents(file: string): number {
  if (!file) return 0
  let f = files.get(file)
  if (!f) { f = { cur: cursor(), pending: new Map(), checked: 0 }; files.set(file, f) }
  const e = f
  if (Date.now() - e.checked > 1000) {
    e.checked = Date.now()
    void readAppended(file, e.cur, line => scan(line, e.pending), () => e.pending.clear()).catch(() => {})
  }
  for (const [id, at] of e.pending) if (Date.now() - at > STALE_MS) e.pending.delete(id)
  return e.pending.size
}
