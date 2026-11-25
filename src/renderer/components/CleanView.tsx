import { Fragment, useEffect, useLayoutEffect, useRef, useState, type JSX, type ReactNode } from 'react'

/**
 * Clean view: a Claude Code or Codex tab as a chat. Only the person's messages and the agent's text, read from the
 * transcript (src/main/cleanview.ts); tool calls stay in the terminal underneath, one click (or ⇧⌘E) away. Of the
 * agent's text in a turn, the first (the point list) and the last (the answer) show; anything between folds away.
 */
type Item = { role: 'user' | 'assistant'; text: string; end?: boolean }
type Turn = { user?: Item; replies: Item[]; done: boolean }

function turnsOf(items: Item[]): Turn[] {
  const turns: Turn[] = []
  for (const it of items) {
    if (it.role === 'user' || !turns.length) turns.push({ user: it.role === 'user' ? it : undefined, replies: it.role === 'user' ? [] : [it], done: !!it.end })
    else {
      const t = turns[turns.length - 1]
      // An answer begun, cut off by a tool call and written again in full: only the full one.
      const head = it.text.slice(0, 120)
      t.replies = t.replies.filter(r => !(r.text.length >= 60 && (head.startsWith(r.text.slice(0, 120)) || it.text.startsWith(r.text.slice(0, Math.min(r.text.length, 400))))))
      t.replies.push(it); if (it.end) t.done = true
    }
  }
  return turns
}

// A small Markdown renderer into React elements (never HTML strings): headings, lists, tables, code, quotes, links.
function inline(text: string, key = 'i'): ReactNode[] {
  const out: ReactNode[] = []
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*)|(\[[^\]]+\]\((https?:\/\/[^)\s]+)\))|(https?:\/\/[^\s)]+)/g
  let last = 0, m: RegExpExecArray | null, n = 0
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index))
    const k = `${key}-${n++}`
    if (m[1]) out.push(<code key={k}>{m[1].slice(1, -1)}</code>)
    else if (m[2]) out.push(<strong key={k}>{inline(m[2].slice(2, -2), k)}</strong>)
    else if (m[3]) out.push(<em key={k}>{inline(m[3].slice(1, -1), k)}</em>)
    else if (m[4]) out.push(<a key={k} href={m[5]} target="_blank" rel="noreferrer">{m[4].slice(1, m[4].indexOf(']'))}</a>)
    else if (m[6]) out.push(<a key={k} href={m[6]} target="_blank" rel="noreferrer">{m[6]}</a>)
    last = re.lastIndex
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}
const cells = (row: string) => row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim())
type ListItem = { text: string; children: ListItem[]; childOrdered: boolean; childStart: number }
function list(lines: string[], key: string): JSX.Element {
  const top: ListItem = { text: '', children: [], childOrdered: false, childStart: 1 }
  const stack: { indent: number; item: ListItem }[] = [{ indent: -1, item: top }]
  for (const l of lines) {
    const m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(l)
    if (!m) { const it = stack[stack.length - 1].item; if (it !== top) it.text += '\n' + l.trim(); continue }
    const indent = m[1].length
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop()
    const parent = stack[stack.length - 1].item
    if (!parent.children.length) { parent.childOrdered = /^\d/.test(m[2]); parent.childStart = parent.childOrdered ? parseInt(m[2], 10) : 1 }
    const item: ListItem = { text: m[3], children: [], childOrdered: false, childStart: 1 }
    parent.children.push(item); stack.push({ indent, item })
  }
  const render = (it: ListItem, k: string): JSX.Element => {
    const Tag = it.childOrdered ? 'ol' : 'ul'
    return <Tag key={k} start={it.childOrdered && it.childStart !== 1 ? it.childStart : undefined}>{it.children.map((c, i) => <li key={i}>{c.text.split('\n').map((t, j) => <Fragment key={j}>{j ? <br /> : null}{inline(t, `${k}-${i}-${j}`)}</Fragment>)}{c.children.length ? render(c, `${k}-${i}-c`) : null}</li>)}</Tag>
  }
  return render(top, key)
}
export function Markdown({ text }: { text: string }): JSX.Element {
  const lines = text.replace(/\r/g, '').split('\n'), out: ReactNode[] = []
  for (let i = 0; i < lines.length;) {
    const l = lines[i], k = `b${i}`
    if (/^```/.test(l)) {
      const body: string[] = []; i++
      while (i < lines.length && !/^```/.test(lines[i])) body.push(lines[i++])
      i++; out.push(<pre key={k}><code>{body.join('\n')}</code></pre>); continue
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(l)
    if (h) { const T = `h${Math.min(6, h[1].length + 2)}` as 'h3'; out.push(<T key={k}>{inline(h[2], k)}</T>); i++; continue }
    if (/^\s*\|.*\|\s*$/.test(l) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
      const head = cells(l); i += 2
      const rows: string[][] = []
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(cells(lines[i++]))
      out.push(<div key={k} className="clean-table"><table><thead><tr>{head.map((c, j) => <th key={j}>{inline(c, `${k}h${j}`)}</th>)}</tr></thead><tbody>{rows.map((r, ri) => <tr key={ri}>{r.map((c, j) => <td key={j}>{inline(c, `${k}r${ri}c${j}`)}</td>)}</tr>)}</tbody></table></div>)
      continue
    }
    if (/^\s*([-*+]|\d+[.)])\s+/.test(l)) {
      const block: string[] = []
      while (i < lines.length && (/^\s*([-*+]|\d+[.)])\s+/.test(lines[i]) || (/^\s+\S/.test(lines[i]) && block.length))) block.push(lines[i++])
      out.push(list(block, k)); continue
    }
    if (/^>\s?/.test(l)) {
      const q: string[] = []
      while (i < lines.length && /^>\s?/.test(lines[i])) q.push(lines[i++].replace(/^>\s?/, ''))
      out.push(<blockquote key={k}>{inline(q.join(' '), k)}</blockquote>); continue
    }
    if (!l.trim()) { i++; continue }
    const para: string[] = []
    while (i < lines.length && lines[i].trim() && !/^(```|#{1,6}\s|>\s?|\s*([-*+]|\d+[.)])\s+)/.test(lines[i]) && !/^\s*\|.*\|\s*$/.test(lines[i])) para.push(lines[i++])
    out.push(<p key={k}>{para.map((p, j) => <Fragment key={j}>{j ? <br /> : null}{inline(p, `${k}-${j}`)}</Fragment>)}</p>)
  }
  return <>{out}</>
}

export function CleanView({ tabId, status, onTerminal }: { tabId: string; status: string; onTerminal: () => void }): JSX.Element {
  const [items, setItems] = useState<Item[] | null>(null)
  const [draft, setDraft] = useState('')
  const [open, setOpen] = useState<Record<number, boolean>>({})
  const version = useRef(-1), scroller = useRef<HTMLDivElement>(null), stick = useRef(true), box = useRef<HTMLTextAreaElement>(null)
  // Typing goes here, not to the terminal underneath (which takes focus when its tab opens).
  useEffect(() => { const t = [0, 80, 300].map(ms => setTimeout(() => box.current?.focus(), ms)); return () => t.forEach(clearTimeout) }, [tabId])
  useEffect(() => {
    let stop = false
    version.current = -1; setItems(null)
    const poll = async () => {
      const r = await window.term.pty.cleanRead(tabId, version.current).catch(() => null)
      if (stop || !r) return
      if (r.items) { version.current = r.version; setItems(r.items) }
    }
    void poll(); const t = setInterval(poll, 1000)
    return () => { stop = true; clearInterval(t) }
  }, [tabId])
  useLayoutEffect(() => { const el = scroller.current; if (el && stick.current) el.scrollTop = el.scrollHeight }, [items, status])
  const send = () => { const text = draft.trim(); if (!text) return; setDraft(''); stick.current = true; void window.term.pty.cleanSend(tabId, text) }
  const turns = turnsOf(items ?? [])
  const working = status === 'working'
  return <div className="clean-view" aria-label="Clean view">
    <div className="clean-bar">
      <span className="clean-title">Clean view</span>
      <span className="clean-status">{working ? 'Working…' : status === 'question' ? 'Waiting for your answer in the terminal' : ''}</span>
      <button className="btn" title="Show the terminal with every step  ⇧⌘E" onClick={onTerminal}>Terminal</button>
    </div>
    <div className="clean-scroll" ref={scroller} onScroll={e => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40 }}>
      {items === null ? <div className="clean-empty">Loading the conversation…</div>
        : !turns.length ? <div className="clean-empty">Nothing here yet. Type below to start.</div>
        : turns.map((t, ti) => {
          const shown = t.replies.length <= 2 || open[ti] ? t.replies : [t.replies[0], t.replies[t.replies.length - 1]]
          const hidden = t.replies.length - shown.length
          return <div key={ti} className="clean-turn">
            {t.user && <div className="clean-msg user"><Markdown text={t.user.text} /></div>}
            {shown.map((r, ri) => <Fragment key={ri}>
              {ri === 1 && hidden > 0 && <button className="clean-more" onClick={() => setOpen(o => ({ ...o, [ti]: true }))}>{hidden} update{hidden === 1 ? '' : 's'} in between</button>}
              <div className="clean-msg assistant"><Markdown text={r.text} /></div>
            </Fragment>)}
          </div>
        })}
      {working && <div className="clean-working"><span /><span /><span /></div>}
    </div>
    <form className="clean-input" onSubmit={e => { e.preventDefault(); send() }}>
      <textarea ref={box} value={draft} rows={Math.min(8, Math.max(1, draft.split('\n').length))} placeholder={working ? 'Message (sent when it is your turn, like in the terminal)…' : 'Message…'}
        onChange={e => setDraft(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send() } }} />
      <button className="btn primary" type="submit" disabled={!draft.trim()}>Send</button>
    </form>
  </div>
}
