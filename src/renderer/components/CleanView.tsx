import { Fragment, useEffect, useLayoutEffect, useRef, useState, type JSX, type ReactNode } from 'react'
import { finders, screens, streamingAnswer } from '../find'

/**
 * Clean view: a Claude Code or Codex tab as a chat. Only the person's messages and the agent's text, read from the
 * transcript (src/main/cleanview.ts); tool calls stay in the terminal underneath, one click (or ⇧⌘E) away. Of the
 * agent's text in a turn, the first (the point list) and the last (the answer) show; anything between folds away.
 */
/**
 * A prompt as the person reads it: a message another agent sent in ("[TerminAI · reply from Matteo's agent to your message …] …")
 * gets a small header (the full line in its tooltip) instead of the raw bracket, and text pasted into the prompt
 * (<pasted_content …>…</pasted_content …>) shows as a quoted block, folded when it is long.
 */
function UserText({ text }: { text: string }): JSX.Element {
  const head = /^\[TerminAI · ([^\]]{1,600})\]\s*/.exec(text)
  const body = head ? text.slice(head[0].length) : text
  const title = head ? head[1].split(/,| id [0-9a-f-]{36}| to your message [0-9a-f-]{36}|\. /)[0].trim() : ''
  const parts: { paste: boolean; text: string }[] = []
  const re = /<pasted_content[^>]*>([\s\S]*?)<\/pasted_content[^>]*>/g
  let at = 0, m: RegExpExecArray | null
  while ((m = re.exec(body))) { if (m.index > at) parts.push({ paste: false, text: body.slice(at, m.index) }); parts.push({ paste: true, text: m[1].trim() }); at = m.index + m[0].length }
  if (at < body.length) parts.push({ paste: false, text: body.slice(at) })
  return <>
    {head && <div className="clean-from" title={head[1]}><span aria-hidden="true">{/^reply/i.test(title) ? '↩' : '✉'}</span>{title.charAt(0).toUpperCase() + title.slice(1)}</div>}
    {parts.map((p, i) => p.paste
      ? <details key={i} className="clean-paste" open={p.text.split('\n').length <= 8}><summary>Pasted text · {p.text.split('\n').length} line{p.text.split('\n').length === 1 ? '' : 's'}</summary><div className="clean-paste-body">{p.text}</div></details>
      : p.text.trim() ? <Markdown key={i} text={p.text.trim()} /> : null)}
  </>
}
type Item = { role: 'user' | 'assistant' | 'note'; text: string; end?: boolean }
type Turn = { user?: Item; note?: Item; replies: Item[]; done: boolean }

function turnsOf(items: Item[]): Turn[] {
  const turns: Turn[] = []
  for (const it of items) {
    if (it.role === 'note') { turns.push({ note: it, replies: [], done: false }); continue }
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
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*)|(\[[^\]]+\]\((https?:\/\/[^)\s]+)\))|((?:https?|terminai):\/\/[^\s)]+)/g
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

type Attachment = { path: string; name: string; image: boolean; thumb?: string }
type Queued = { text: string; files: Attachment[]; at: number; users: number }
/** What is typed, attached and queued in each tab's box: kept when you switch tabs and come back. */
const boxes = new Map<string, { draft: string; files: Attachment[]; pending: Queued[] }>()
const IMAGE = /\.(png|jpe?g|gif|webp|heic|bmp|tiff?)$/i

export function CleanView({ tabId, status, onTerminal }: { tabId: string; status: string; onTerminal: () => void }): JSX.Element {
  const [items, setItems] = useState<Item[] | null>(null)
  const saved = boxes.get(tabId) ?? { draft: '', files: [], pending: [] }
  const [draft, setDraft] = useState(saved.draft)
  const [files, setFiles] = useState<Attachment[]>(saved.files)
  const [pending, setPending] = useState<Queued[]>(saved.pending)
  useEffect(() => { boxes.set(tabId, { draft, files, pending }) }, [tabId, draft, files, pending])
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
  // ⌘F while the Clean view is shown searches the conversation here (highlighted with the CSS Highlight API).
  useEffect(() => {
    const H = (globalThis as any).Highlight, reg = (CSS as any).highlights
    let ranges: Range[] = [], at = -1, query = ''
    const collect = (q: string) => {
      ranges = []; const root = scroller.current; if (!root || !q) return
      const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT), lq = q.toLowerCase()
      for (let n = w.nextNode(); n; n = w.nextNode()) {
        const t = (n.textContent || '').toLowerCase()
        for (let i = t.indexOf(lq); i >= 0; i = t.indexOf(lq, i + lq.length)) { const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + q.length); ranges.push(r) }
      }
    }
    const paint = () => {
      if (!reg || !H) return
      reg.set('clean-find', new H(...ranges)); reg.set('clean-find-current', at >= 0 && ranges[at] ? new H(ranges[at]) : new H())
      const r = ranges[at]; if (r) { stick.current = false; (r.startContainer.parentElement as HTMLElement | null)?.scrollIntoView({ block: 'center' }) }
    }
    finders.set(`clean:${tabId}`, {
      find: async (q, back, incremental) => {
        if (q !== query || !incremental) { const changed = q !== query; query = q; collect(q); if (changed) at = back ? ranges.length : -1 }
        if (!ranges.length) { at = -1; paint(); return { index: -1, count: 0 } }
        if (!incremental || at < 0) at = back ? (at - 1 + ranges.length) % ranges.length : (at + 1) % ranges.length
        paint(); return { index: at, count: ranges.length }
      },
      clear: () => { ranges = []; at = -1; query = ''; reg?.delete('clean-find'); reg?.delete('clean-find-current') },
    })
    return () => { finders.delete(`clean:${tabId}`); reg?.delete('clean-find'); reg?.delete('clean-find-current') }
  }, [tabId])
  const [dragging, setDragging] = useState(false)
  // The box grows with what is typed, wrapped lines included, up to about ten lines; then it scrolls.
  useLayoutEffect(() => { const el = box.current; if (!el) return; el.style.height = 'auto'; el.style.height = `${Math.min(el.scrollHeight, 10 * 22 + 10)}px`; el.style.overflowY = el.scrollHeight > 10 * 22 + 10 ? 'auto' : 'hidden' }, [draft])
  // Files and pictures become attachments above the text (a picture with its thumbnail); they go in as their paths when
  // sent, the way the terminal takes a drop, and Claude Code turns a picture's path into [Image #n].
  const attach = (paths: string[]) => {
    const add = paths.filter(Boolean).map(p => ({ path: p, name: p.split('/').pop() || p, image: IMAGE.test(p) }))
    if (!add.length) return
    setFiles(f => [...f, ...add.filter(x => !f.some(y => y.path === x.path))])
    for (const a of add) if (a.image) void window.term.pty.cleanThumb(a.path).then(t => { if (t) setFiles(f => f.map(x => x.path === a.path ? { ...x, thumb: t } : x)) })
    box.current?.focus()
  }
  const quote = (p: string) => /^[A-Za-z0-9_@%+=:,./-]+$/.test(p) ? p : `'${p.replace(/'/g, `'\\''`)}'`
  const saveAll = (list: File[]) => Promise.all(list.filter(f => f.type.startsWith('image/')).map(async f => window.term.pty.cleanSaveImage(await f.arrayBuffer(), f.type))).then(attach)
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault(); e.stopPropagation(); setDragging(false)
    const team = e.dataTransfer.getData('application/x-terminai-teamfile')
    if (team) { try { const f = JSON.parse(team) as { company: string; id: string; name: string }; void window.term.teamchat.fetch(f.company, f.id, f.name).then(p => attach([p])).catch(() => {}) } catch {} return }
    const list = Array.from(e.dataTransfer.files), paths = list.map(f => window.term.files.pathFor(f)).filter(Boolean)
    if (paths.length) { attach(paths); return }
    if (list.length) { void saveAll(list); return }
    const text = e.dataTransfer.getData('text/uri-list').trim() || e.dataTransfer.getData('text/plain')
    if (text && !/^(data|blob):/i.test(text) && text.length < 20000) setDraft(d => d ? `${d} ${text}` : text)
  }
  const onPaste = (e: React.ClipboardEvent) => {
    const list = Array.from(e.clipboardData.files)
    if (!list.length || e.clipboardData.getData('text/plain')) return
    e.preventDefault()
    const paths = list.map(f => window.term.files.pathFor(f)).filter(Boolean)
    if (paths.length) attach(paths); else void saveAll(list)
  }
  const userCount = (items ?? []).filter(i => i.role === 'user').length
  const send = () => {
    const text = draft.trim(); if (!text && !files.length) return
    const out = [...files.map(f => quote(f.path)), text].filter(Boolean).join(' ')
    setDraft(''); setFiles([]); stick.current = true
    setPending(p => [...p, { text, files, at: Date.now(), users: userCount }])
    void window.term.pty.cleanSend(tabId, out)
  }
  // Claude Code's "send now" for a queued message (ctrl+x ctrl+s): it stops waiting for the turn to end.
  const sendNow = () => { window.term.pty.write(tabId, '\x18\x13'); box.current?.focus() }
  // A queued message leaves the list once the conversation has it (its words, or any new message for pictures alone).
  useEffect(() => {
    if (!items || !pending.length) return
    const users = items.filter(i => i.role === 'user'), said = users.slice(-20).map(i => i.text.replace(/\s+/g, ' '))
    setPending(p => p.filter(q => {
      if (Date.now() - q.at > 30 * 60_000) return false
      const t = q.text.replace(/\s+/g, ' ').slice(0, 200)
      // Gone once the conversation has it: its words, or simply a new message of yours since it was sent (Claude Code may
      // rewrite what it shows, e.g. pictures as [Image #1], so the words alone can miss it and leave it stuck as "Sending…").
      return users.length <= q.users && (!t || !said.some(u => u.includes(t)))
    }))
  }, [items])
  // Streaming: while it works, the answer being written is read off the terminal screen and shown as it grows, until
  // the transcript has it.
  const [stream, setStream] = useState('')
  useEffect(() => {
    if (status !== 'working') { setStream(''); return }
    // Steady: a streamed answer stays until a new one replaces it or the turn ends (no blinking while tools run in between).
    const t = setInterval(() => { const read = screens.get(tabId); const now = read ? streamingAnswer(read()) : ''; if (now) setStream(now) }, 300)
    return () => clearInterval(t)
  }, [tabId, status])
  const lastSaid = [...(items ?? [])].reverse().find(i => i.role === 'assistant')?.text ?? ''
  const streaming = stream && !lastSaid.replace(/\s+/g, ' ').startsWith(stream.replace(/\s+/g, ' ').slice(0, 80)) ? stream : ''
  const turns = turnsOf(items ?? [])
  const working = status === 'working'
  return <div className="clean-view" aria-label="Clean view">
    <div className="clean-bar">
      <span className="clean-status">{working ? 'Working…' : status === 'question' ? 'Waiting for your answer in the terminal' : ''}</span>
      <button className="clean-switch" title="Show the terminal with every step" onClick={onTerminal}>Terminal <span className="kbd">⇧⌘E</span></button>
    </div>
    <div className="clean-scroll" ref={scroller} onScroll={e => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40 }}>
      {items === null ? <div className="clean-empty">Loading the conversation…</div>
        : !turns.length ? <div className="clean-empty">Nothing here yet. Type below to start.</div>
        : turns.map((t, ti) => {
          const shown = t.replies.length <= 2 || open[ti] ? t.replies : [t.replies[0], t.replies[t.replies.length - 1]]
          const hidden = t.replies.length - shown.length
          return <div key={ti} className="clean-turn">
            {t.note && <div className="clean-note"><span>⚙</span>{t.note.text}</div>}
            {t.user && <div className="clean-msg user"><UserText text={t.user.text} /></div>}
            {shown.map((r, ri) => <Fragment key={ri}>
              {ri === 1 && hidden > 0 && <button className="clean-more" onClick={() => setOpen(o => ({ ...o, [ti]: true }))}>{hidden} update{hidden === 1 ? '' : 's'} in between</button>}
              <div className="clean-msg assistant"><Markdown text={r.text} /></div>
            </Fragment>)}
          </div>
        })}
      {streaming && <div className="clean-turn"><div className="clean-msg assistant streaming"><Markdown text={streaming} /></div></div>}
      {working && <div className="clean-working"><span /><span /><span /></div>}
      {pending.map(q => <div key={q.at} className="clean-turn"><div className="clean-msg user queued">{q.files.length > 0 && <div className="clean-chips">{q.files.map((f, i) => <span key={f.path} className="clean-chip">{f.thumb ? <img src={f.thumb} alt="" /> : <span className="clean-chip-icon">{f.image ? '▣' : '▤'}</span>}{f.image ? `Image ${i + 1}` : f.name}</span>)}</div>}{q.text && <Markdown text={q.text} />}</div>
        <div className="clean-queued-note">{working ? <>Queued: it goes in when this turn ends · <button type="button" className="clean-link" onClick={sendNow}>send now</button> <span className="kbd">⌃X ⌃S</span></> : 'Sending…'}</div></div>)}
    </div>
    <form className={`clean-input${dragging ? ' dragging' : ''}`} onSubmit={e => { e.preventDefault(); send() }}
      onDragOver={e => { e.preventDefault(); e.stopPropagation(); setDragging(true) }} onDragLeave={() => setDragging(false)} onDrop={onDrop}>
      <div className="clean-box">
        {files.length > 0 && <div className="clean-chips">{files.map((f, i) => <span key={f.path} className="clean-chip" title={f.path}>
          {f.thumb ? <img src={f.thumb} alt="" /> : <span className="clean-chip-icon">{f.image ? '▣' : '▤'}</span>}
          <span className="clean-chip-name">{f.image ? `Image ${files.slice(0, i + 1).filter(x => x.image).length}` : f.name}</span>
          <button type="button" aria-label={`Remove ${f.name}`} onClick={() => setFiles(l => l.filter(x => x.path !== f.path))}>×</button>
        </span>)}</div>}
        <div className="clean-row">
          <textarea ref={box} value={draft} rows={1} placeholder={working ? 'Reply… it goes in when this turn ends' : 'Reply…'}
            onChange={e => setDraft(e.target.value)} onPaste={onPaste}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send() } }} />
          <button className="clean-send" type="submit" disabled={!draft.trim() && !files.length} aria-label="Send" title="Send  ↩">
            <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M12 19V5M5.5 11.5 12 5l6.5 6.5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </button>
        </div>
      </div>
    </form>
  </div>
}
