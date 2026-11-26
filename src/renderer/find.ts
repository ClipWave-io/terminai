/**
 * ⌘F inside a conversation: each terminal (and each Clean view while it is shown) registers how to search its own
 * text; the find bar asks the one in view. `find` returns where it landed: the match number and how many there are.
 */
export type FindResult = { index: number; count: number }
export type Finder = { find: (query: string, back: boolean, incremental: boolean) => Promise<FindResult>; clear: () => void }
export const finders = new Map<string, Finder>()

/** The terminal's last screenfuls as plain lines, per tab: the Clean view reads the answer Claude Code is writing now from it. */
export const screens = new Map<string, () => string[]>()

/**
 * The answer Claude Code is writing right now, from the terminal screen: the last "⏺ text" block when nothing but the
 * spinner follows it (a tool call or a finished turn means nothing is streaming). Claude Code wraps lines itself, so
 * wrapped lines are joined back; list items, headings, tables and blank lines keep their breaks.
 */
export function streamingAnswer(lines: string[]): string {
  // Above the input box (its top border is the second-to-last rule).
  const rules = lines.map((l, i) => /^─{5,}/.test(l) ? i : -1).filter(i => i >= 0)
  let end = rules.length >= 2 ? rules[rules.length - 2] : lines.length
  // Past the spinner ("✻ Crunching…") and its tip, and blank lines.
  while (end > 0 && (!lines[end - 1].trim() || /^[✻✳✶✷✸✹✺✼✽✢·*] /.test(lines[end - 1]) || /^\s+⎿\s+Tip/.test(lines[end - 1]))) end--
  let j = end - 1
  while (j >= 0 && !/^⏺ /.test(lines[j])) j--
  if (j < 0) return ''
  const head = lines[j].slice(2)
  if (/^[A-Za-z][\w.:-]*\(/.test(head)) return ''          // a tool call, not text
  // Claude Code's grouped tool lines ("Calling terminai-browser 2 times… (ctrl+o to expand)", "Read 3 files"): not text.
  if (/ctrl\+o|^(Calling|Called|Running|Ran|Reading|Read|Searching|Searched|Listing|Listed|Fetching|Fetched|Writing|Wrote|Updating|Updated|Editing|Edited)\b.*(\d+ (times|files?|patterns?)|…)/.test(head)) return ''
  const block = [head, ...lines.slice(j + 1, end).map(l => l.replace(/^ {2}/, ''))]
  if (block.some(l => /^\s*⎿/.test(l))) return ''
  // A later prompt ("❯ …") or the turn's end line ("✻ Churned for 57s · done …") under it: that block is a past answer.
  if (lines.slice(j + 1, end).some(l => /^❯ /.test(l) || /^[✻✳✶✷✸✹✺✼✽✢·*] .*\b(for \d|done)\b/.test(l))) return ''
  const width = Math.max(...block.map(l => l.length))
  const out: string[] = []
  for (const l of block) {
    const prev = out[out.length - 1]
    const starts = /^\s*([-*+] |\d+[.)] |#|\||│|┌|├|└)/.test(l)
    if (prev !== undefined && prev.trim() && l.trim() && !starts && prev.length >= width - 18) out[out.length - 1] = `${prev} ${l.trim()}`
    else out.push(l)
  }
  return out.join('\n').trim()
}
