import { useEffect, useRef, useState, type JSX } from 'react'
import type { WorkspaceNote, WorkspaceNoteActivity, WorkspaceNoteComment } from '../../shared/workspace'

/**
 * Beside the open shared note: its comments (threads with replies, resolved as a whole, @mentions that notify) and
 * the activity, of this note or of every note, in the look of the To-do's Activity panel.
 * Every hook of every component here sits above any early return: one placed below them blanks the window.
 */
export type SideTab = 'comments' | 'activity'
const ago = (iso: string) => {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000)
  return s < 60 ? 'just now' : s < 3600 ? `${Math.floor(s / 60)} min ago` : s < 86400 ? `${Math.floor(s / 3600)} h ago` : new Date(iso).toLocaleDateString()
}
const first = (name: string) => name.split(' ')[0] || name
const message = (e: unknown) => e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e)

/** "changed the title", "added 2 files", "commented: “…”" — what one activity row says, after the person's name. */
export function activityText(a: WorkspaceNoteActivity): string {
  const d = a.detail ?? {}, names = d.names ?? [], count = d.count ?? names.length
  switch (a.action) {
    case 'created': return 'created the note'
    case 'deleted': return 'deleted the note'
    case 'edited': {
      const f = d.fields ?? []
      if (f.includes('title') && f.includes('body')) return 'edited the title and the text'
      if (f.includes('title')) return 'changed the title'
      if (f.includes('body')) return 'edited the text'
      if (f.includes('status')) return 'changed its status'
      if (f.includes('visibility')) return 'changed who sees it'
      return 'edited the note'
    }
    case 'product': return d.to ? `moved it to ${d.to}` : `took it out of ${d.from || 'its product'}`
    case 'file_added': return count > 1 ? `added ${count} files` : `added ${names[0] ?? 'a file'}`
    case 'file_removed': return count > 1 ? `removed ${count} files` : `removed ${names[0] ?? 'a file'}`
    case 'commented': return `${d.reply ? 'replied' : 'commented'}${d.excerpt ? `: “${d.excerpt}”` : ''}`
    case 'resolved': return `resolved a comment${d.excerpt ? `: “${d.excerpt}”` : ''}`
    case 'reopened': return `reopened a comment${d.excerpt ? `: “${d.excerpt}”` : ''}`
    default: return 'changed the note'
  }
}

/** @names in a comment, marked like the To-do's mentions. */
function Body({ text }: { text: string }): JSX.Element {
  return <>{text.split(/(@[\p{L}\p{N}_.-]{2,40})/u).map((part, i) => i % 2 ? <span key={i} className="todo-mention">{part}</span> : part)}</>
}

// Unsent comments, per note and per reply: they outlive switching notes, closing the panel and restarting the app.
const DRAFTS_KEY = 'terminai.noteCommentDrafts'
let drafts: Record<string, string> = {}
try { drafts = JSON.parse(localStorage.getItem(DRAFTS_KEY) ?? '{}') ?? {} } catch {}
const keepDraft = (key: string, value: string) => {
  if (value) drafts[key] = value; else delete drafts[key]
  try { localStorage.setItem(DRAFTS_KEY, JSON.stringify(drafts)) } catch {}
}

/** The comment box. Its draft is kept under draftKey until it is sent; ⌘↩ sends, Esc cancels a reply or an edit. */
function Composer({ draftKey, initial = '', placeholder, action, people, autoFocus, onSubmit, onCancel }: { draftKey: string; initial?: string; placeholder: string; action: string
  people: string[]; autoFocus?: boolean; onSubmit: (body: string) => Promise<void>; onCancel?: () => void }): JSX.Element {
  const [value, setValue] = useState(() => drafts[draftKey] ?? initial)
  const [busy, setBusy] = useState(false)
  const box = useRef<HTMLTextAreaElement>(null)
  const set = (v: string) => { setValue(v); keepDraft(draftKey, v === initial ? '' : v) }
  // Typing @ and a few letters offers the teammates whose name starts with them.
  const partial = /(?:^|\s)@([\p{L}\p{N}_.-]{0,40})$/u.exec(value)?.[1]?.toLowerCase()
  const offers = partial === undefined ? [] : people.filter(p => p.toLowerCase().startsWith(partial) && p.toLowerCase() !== partial).slice(0, 5)
  const send = async () => {
    const body = value.trim(); if (!body || busy) return
    setBusy(true)
    try { await onSubmit(body); keepDraft(draftKey, ''); setValue('') } catch { /* the panel shows the error; the draft stays */ } finally { setBusy(false) }
  }
  return <form className="snotes-composer" onSubmit={e => { e.preventDefault(); void send() }}>
    <textarea ref={box} rows={2} maxLength={4000} value={value} placeholder={placeholder} aria-label={placeholder} autoFocus={autoFocus}
      onChange={e => set(e.target.value)}
      onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void send() } if (e.key === 'Escape' && onCancel) { e.preventDefault(); e.stopPropagation(); onCancel() } }} />
    {offers.length > 0 && <div className="snotes-mention-offers" role="listbox" aria-label="Mention">
      {offers.map(p => <button type="button" key={p} role="option" aria-selected={false} onClick={() => { set(value.replace(/@[\p{L}\p{N}_.-]*$/u, `@${p} `)); box.current?.focus() }}>@{p}</button>)}</div>}
    <div className="snotes-composer-bar">
      <span className="todo-muted">{value.trim() ? '⌘↩ to send' : 'Type @ to notify someone'}</span>
      {onCancel && <button type="button" className="todo-link" onClick={onCancel}>Cancel</button>}
      <button type="submit" className="btn primary" disabled={busy || !value.trim()}>{action}</button>
    </div>
  </form>
}

function CommentView({ c, people, onEdit, onResolve, onDelete, onReply }: { c: WorkspaceNoteComment; people: string[]
  onEdit: (body: string) => Promise<void>; onResolve?: () => void; onDelete: () => void; onReply?: () => void }): JSX.Element {
  const [editing, setEditing] = useState(false)
  const [asking, setAsking] = useState(false)
  return <div className="snotes-comment">
    <div className="snotes-comment-head">
      <strong>{first(c.authorName)}</strong>
      <time dateTime={c.createdAt} title={new Date(c.createdAt).toLocaleString()}>{ago(c.createdAt)}{c.editedAt ? ' · edited' : ''}</time>
      <span className="snotes-comment-acts">
        {onReply && <button className="todo-link" onClick={onReply}>Reply</button>}
        {onResolve && <button className="todo-link" title={c.resolvedAt ? 'Open the thread again' : 'Mark the thread resolved'} onClick={onResolve}>{c.resolvedAt ? 'Reopen' : 'Resolve'}</button>}
        {c.canEdit && !editing && <button className="todo-link" onClick={() => setEditing(true)}>Edit</button>}
        {c.canEdit && (asking ? <><button className="todo-link danger" onClick={onDelete}>Delete{c.parentId ? '' : ' thread'}</button><button className="todo-link" onClick={() => setAsking(false)}>Keep</button></>
          : <button className="todo-link" onClick={() => setAsking(true)}>Delete</button>)}
      </span>
    </div>
    {editing ? <Composer draftKey={`edit:${c.id}`} initial={c.body} placeholder="Edit the comment" action="Save" people={people} autoFocus
        onSubmit={async body => { await onEdit(body); setEditing(false) }} onCancel={() => { keepDraft(`edit:${c.id}`, ''); setEditing(false) }} />
      : <p className="snotes-comment-body"><Body text={c.body} /></p>}
  </div>
}

export function NoteSide({ base, note, notes, tab, onTab, scope, onScope, product = '', onClose, onOpen, refresh, onCount }: {
  /** /api/companies/<id>/notes */ base: string; note: WorkspaceNote | undefined; notes: WorkspaceNote[]; tab: SideTab
  onTab: (tab: SideTab) => void; scope: 'note' | 'all'; onScope: (scope: 'note' | 'all') => void
  /** The product the To-do header picked ('' all): the activity of all notes shows that product's. */ product?: string
  onClose: () => void; onOpen: (noteId: string) => void
  /** Changes whenever a note changed (the newest edit), so the activity reloads at once. */ refresh: string
  onCount?: (open: number) => void
}): JSX.Element {
  const [comments, setComments] = useState<WorkspaceNoteComment[]>([])
  const [canComment, setCanComment] = useState(true)
  const [activity, setActivity] = useState<WorkspaceNoteActivity[]>([])
  const [showResolved, setShowResolved] = useState(false)
  const [replyTo, setReplyTo] = useState('')
  const [people, setPeople] = useState<string[]>([])
  const [error, setError] = useState('')
  const noteId = note?.id ?? ''
  const company = base.replace(/\/notes$/, '')
  const loadComments = () => noteId ? window.term.workspace.request(`${base}/${noteId}/comments`).then(v => {
    setComments(v.comments ?? []); setCanComment(v.canComment !== false); setError('')
  }).catch(e => setError(message(e))) : Promise.resolve()
  const loadActivity = () => (scope === 'all' || noteId) ? window.term.workspace.request(scope === 'all' ? `${base}/activity?limit=200` : `${base}/${noteId}/activity`)
    .then(v => { setActivity((v.activity ?? []).filter((a: WorkspaceNoteActivity) => a.noteKind === 'doc')); setError('') }).catch(e => setError(message(e))) : Promise.resolve()
  // The open note's comments, and the activity shown, again every 15 seconds like the notes themselves.
  useEffect(() => { setComments([]); setReplyTo(''); void loadComments(); const t = window.setInterval(() => void loadComments(), 15000); return () => window.clearInterval(t) }, [noteId])
  useEffect(() => { if (tab !== 'activity') return; void loadActivity(); const t = window.setInterval(() => void loadActivity(), 15000); return () => window.clearInterval(t) }, [tab, scope, noteId, refresh])
  useEffect(() => { window.term.workspace.request(`${company}/members`).then(v => setPeople([...new Set<string>((v.members ?? []).map((m: { name: string }) => first(m.name)).filter(Boolean))])).catch(() => {}) }, [company])
  const open = comments.filter(c => !c.parentId && !c.resolvedAt).length
  useEffect(() => { onCount?.(open) }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  const act = async (run: () => Promise<unknown>) => {
    try { await run(); await loadComments(); if (tab === 'activity') void loadActivity() } catch (e) { setError(message(e)); throw e }
  }
  const post = (body: string, parentId?: string) => act(() => window.term.workspace.request(`${base}/${noteId}/comments`, 'POST', parentId ? { body, parentId } : { body }))
  const patch = (c: WorkspaceNoteComment, change: { body?: string; resolved?: boolean }) => act(() => window.term.workspace.request(`${base}/${noteId}/comments/${c.id}`, 'PATCH', change))
  const remove = (c: WorkspaceNoteComment) => act(() => window.term.workspace.request(`${base}/${noteId}/comments/${c.id}`, 'DELETE')).catch(() => {})
  const threads = comments.filter(c => !c.parentId && (showResolved || !c.resolvedAt))
  const resolvedCount = comments.filter(c => !c.parentId && c.resolvedAt).length
  const live = new Set(notes.map(n => n.id))
  const shown = activity.filter(a => scope === 'note' || !product || a.product === product)

  return <aside className="todo-activity snotes-side" aria-label={tab === 'comments' ? 'Comments' : 'Note activity'}>
    <div className="todo-activity-head">
      <span className="snotes-side-tabs" role="tablist" aria-label="Comments or activity">
        <button role="tab" aria-selected={tab === 'comments'} className={tab === 'comments' ? 'on' : ''} onClick={() => onTab('comments')}>Comments{open ? ` · ${open}` : ''}</button>
        <button role="tab" aria-selected={tab === 'activity'} className={tab === 'activity' ? 'on' : ''} onClick={() => onTab('activity')}>Activity</button>
      </span>
      <button className="todo-icon" aria-label="Close the side panel" title="Close" onClick={onClose}>×</button>
    </div>
    {error && <p className="todo-error snotes-side-error" role="alert">{error}</p>}
    {tab === 'comments' ? <>
      <div className="todo-activity-filters" role="group" aria-label="Which comments">
        <button aria-pressed={!showResolved} onClick={() => setShowResolved(false)}>Open</button>
        <button aria-pressed={showResolved} onClick={() => setShowResolved(true)}>All{resolvedCount ? ` · ${resolvedCount} resolved` : ''}</button>
      </div>
      {!note ? <p className="todo-muted todo-activity-empty">Open a note to see its comments.</p> : <>
        {canComment ? <div className="snotes-new-comment"><Composer key={noteId} draftKey={noteId} placeholder="Add a comment" action="Comment" people={people} onSubmit={body => post(body)} /></div>
          : <p className="todo-muted todo-activity-empty">Viewers read the comments but cannot write them.</p>}
        <ol className="snotes-threads" aria-label="Comment threads">
          {threads.map(t => <li key={t.id} className={`snotes-thread${t.resolvedAt ? ' resolved' : ''}`}>
            {t.resolvedAt && <span className="snotes-resolved">Resolved{t.resolvedByName ? ` by ${first(t.resolvedByName)}` : ''} · {ago(t.resolvedAt)}</span>}
            <CommentView c={t} people={people} onEdit={body => patch(t, { body })} onDelete={() => void remove(t)}
              onResolve={t.canResolve ? () => void patch(t, { resolved: !t.resolvedAt }).catch(() => {}) : undefined}
              onReply={canComment && !t.resolvedAt && replyTo !== t.id ? () => setReplyTo(t.id) : undefined} />
            {comments.filter(r => r.parentId === t.id).map(r => <div key={r.id} className="snotes-reply">
              <CommentView c={r} people={people} onEdit={body => patch(r, { body })} onDelete={() => void remove(r)} /></div>)}
            {replyTo === t.id && <div className="snotes-reply"><Composer key={`${noteId}:${t.id}`} draftKey={`${noteId}:${t.id}`} placeholder="Reply" action="Reply" people={people} autoFocus
              onSubmit={async body => { await post(body, t.id); setReplyTo('') }} onCancel={() => setReplyTo('')} /></div>}
          </li>)}
          {!threads.length && <li className="todo-muted todo-activity-empty">{comments.length ? 'No open comments.' : 'No comments yet.'}</li>}
        </ol>
      </>}
    </> : <>
      <div className="todo-activity-filters" role="group" aria-label="Activity of">
        <button aria-pressed={scope === 'note'} onClick={() => onScope('note')}>This note</button>
        <button aria-pressed={scope === 'all'} onClick={() => onScope('all')}>All notes</button>
      </div>
      <ol className="todo-activity-list" aria-label="Activity">
        {shown.map(a => {
          const there = a.noteExists && live.has(a.noteId)
          return <li key={a.id} className={a.forMe ? 'tagged' : ''}>
            <button disabled={scope === 'note' || !there} title={scope === 'note' ? new Date(a.at).toLocaleString() : there ? `Open “${a.noteTitle}”` : 'That note is gone'} onClick={() => there && onOpen(a.noteId)}>
              <span className="todo-activity-who">{first(a.byName)}</span>
              <span className="todo-activity-when">{ago(a.at)}</span>
              <span className="todo-activity-msg">{scope === 'all' ? <><b className="snotes-act-note">{a.noteTitle || 'Untitled'}</b> · </> : null}{activityText(a)}</span>
            </button>
          </li>
        })}
        {!shown.length && <li className="todo-muted todo-activity-empty">{scope === 'note' && !note ? 'Open a note to see its activity.' : 'Nothing yet.'}</li>}
      </ol>
      <p className="todo-muted todo-activity-foot">{scope === 'all' ? `Every shared note you can open${product ? ` of ${product}` : ''}, newest first.` : 'Who changed this note, and when.'}</p>
    </>}
  </aside>
}
