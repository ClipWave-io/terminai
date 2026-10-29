import { useEffect, useRef, useState } from 'react'
import type { WorkspaceNote, WorkspaceNoteFile, WorkspaceState } from '../../shared/workspace'

/**
 * Shared notes, like Apple Notes: a list on the left, the open note on the right, files dropped into it.
 * They live on the Sync server as notes of kind "doc" on the workspace's shared board, so everyone in the
 * workspace (Matteo and Ilai) reads and edits the same ones; the web and iPhone task boards leave them out.
 */
const COMPANY_KEY = 'terminai.sharedNotesWorkspace'
const ago = (iso: string) => {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000)
  return s < 60 ? 'just now' : s < 3600 ? `${Math.floor(s / 60)} min ago` : s < 86400 ? `${Math.floor(s / 3600)} h ago` : new Date(iso).toLocaleDateString()
}
const size = (n: number) => n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`
const kindOf = (f: WorkspaceNoteFile) => f.mime.startsWith('image/') ? 'IMG' : f.mime === 'application/pdf' ? 'PDF' : f.mime.startsWith('video/') ? 'VID' : f.mime.startsWith('audio/') ? 'AUD'
  : (f.name.split('.').pop() ?? '').slice(0, 4).toUpperCase() || 'FILE'

export function SharedNotes({ onSync }: { onSync: () => void }) {
  const [state, setState] = useState<WorkspaceState | null>(null)
  const [company, setCompany] = useState('')
  const [notes, setNotes] = useState<WorkspaceNote[]>([])
  const [open, setOpen] = useState('')
  const [draft, setDraft] = useState<{ id: string; title: string; body: string } | null>(null)
  const [query, setQuery] = useState('')
  const [error, setError] = useState('')
  const [uploading, setUploading] = useState(0)
  const [over, setOver] = useState(false)
  const [asking, setAsking] = useState(false)
  const saving = useRef<number | null>(null)
  const title = useRef<HTMLInputElement>(null)
  const base = `/api/companies/${company}/notes`
  const fail = (e: unknown) => setError(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e))

  useEffect(() => {
    window.term.workspace.state().then(value => {
      setState(value)
      const ids = value.identity?.companies.map(c => c.id) ?? [], saved = localStorage.getItem(COMPANY_KEY) ?? ''
      setCompany(ids.includes(saved) ? saved : ids[0] ?? '')
    }).catch(e => { setState({ url: '', signedIn: false }); fail(e) })
  }, [])
  const load = () => company ? window.term.workspace.request(base).then(v => {
    const docs = (v.notes ?? []).filter((n: WorkspaceNote) => n.kind === 'doc' && n.visibility === 'company')
      .sort((a: WorkspaceNote, b: WorkspaceNote) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    setNotes(docs); setError('')
    setOpen(id => docs.some((n: WorkspaceNote) => n.id === id) ? id : docs[0]?.id ?? '')
  }).catch(fail) : Promise.resolve()
  // Someone else's edits arrive every 15 seconds; the note being typed in keeps what is typed.
  useEffect(() => { void load(); const timer = window.setInterval(() => void load(), 15000); return () => window.clearInterval(timer) }, [company])
  useEffect(() => { if (company) try { localStorage.setItem(COMPANY_KEY, company) } catch {} }, [company])

  const note = notes.find(n => n.id === open)
  const shown = draft && draft.id === open ? draft : note ? { id: note.id, title: note.title, body: note.body } : null
  const save = (next: { id: string; title: string; body: string }) => {
    setDraft(next)
    if (saving.current) window.clearTimeout(saving.current)
    saving.current = window.setTimeout(() => {
      saving.current = null
      window.term.workspace.request(`${base}/${next.id}`, 'PATCH', { title: next.title.trim() || 'Untitled', body: next.body })
        .then(v => { setNotes(all => all.map(n => n.id === next.id ? v.note : n)); setDraft(d => d && d.id === next.id && d.title === next.title && d.body === next.body ? null : d) })
        .catch(fail)
    }, 600)
  }
  const select = (id: string) => { if (saving.current && draft) { window.clearTimeout(saving.current); saving.current = null; void window.term.workspace.request(`${base}/${draft.id}`, 'PATCH', { title: draft.title.trim() || 'Untitled', body: draft.body }).then(load).catch(fail) }
    setDraft(null); setAsking(false); setOpen(id); void load() }
  const create = async () => {
    try {
      const v = await window.term.workspace.request(base, 'POST', { kind: 'doc', visibility: 'company', title: 'New note', body: '' })
      setNotes(all => [v.note, ...all]); select(v.note.id)
      requestAnimationFrame(() => { title.current?.focus(); title.current?.select() })
    } catch (e) { fail(e) }
  }
  const remove = async () => {
    if (!note) return
    try { await window.term.workspace.request(`${base}/${note.id}`, 'DELETE'); setDraft(null); setAsking(false); setOpen(''); await load() } catch (e) { fail(e) }
  }
  const attach = async (paths: string[]) => {
    if (!note || !paths.length) return
    setUploading(n => n + paths.length)
    for (const path of paths) {
      try { await window.term.workspace.attach(`${base}/${note.id}`, path) } catch (e) { fail(e) }
      setUploading(n => n - 1)
    }
    await load()
  }
  const detach = async (file: WorkspaceNoteFile) => {
    if (!note) return
    try { await window.term.workspace.request(`${base}/${note.id}/files/${file.id}`, 'DELETE'); await load() } catch (e) { fail(e) }
  }
  const show = (file: WorkspaceNoteFile, reveal = false) => note && window.term.workspace.openFile(`${base}/${note.id}`, file.id, file.name, reveal).catch(fail)

  if (!state) return <div className="snotes-empty">Loading…</div>
  if (!state.signedIn || !company) return <div className="snotes-empty">
    <h2>Shared notes</h2>
    <p>Notes you and Matteo both read and edit, with files in them. They sync through TerminAI Sync, the same account as the website and the iPhone app.</p>
    <button className="btn primary" onClick={onSync}>Sign in to Sync</button>
  </div>

  const q = query.trim().toLowerCase()
  const listed = q ? notes.filter(n => `${n.title}\n${n.body}\n${(n.files ?? []).map(f => f.name).join(' ')}`.toLowerCase().includes(q)) : notes
  const files = note?.files ?? []
  return <div className="snotes">
    <aside className="snotes-list" aria-label="Shared notes">
      <div className="snotes-tools">
        <input className="snotes-search" type="search" placeholder="Search" aria-label="Search notes" value={query} onChange={e => setQuery(e.target.value)} />
        <button className="todo-icon snotes-new" aria-label="New note" title="New note" onClick={() => void create()}>
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3v10M3 8h10" /></svg></button>
      </div>
      {(state.identity?.companies.length ?? 0) > 1 && <select className="snotes-workspace" aria-label="Workspace" value={company} onChange={e => { setDraft(null); setOpen(''); setCompany(e.target.value) }}>
        {state.identity?.companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select>}
      <ul>
        {listed.map(n => <li key={n.id}>
          <button className={`snotes-item${n.id === open ? ' on' : ''}`} onClick={() => select(n.id)}>
            <strong>{(draft?.id === n.id ? draft.title : n.title) || 'Untitled'}</strong>
            <span>{ago(n.updatedAt)}{n.updatedByName ? ` · ${n.updatedByName.split(' ')[0]}` : ''}{n.files?.length ? ` · ${n.files.length} file${n.files.length > 1 ? 's' : ''}` : ''}</span>
            <em>{(draft?.id === n.id ? draft.body : n.body).split('\n').find(line => line.trim()) ?? 'No text'}</em>
          </button>
        </li>)}
        {!listed.length && <li className="snotes-none">{q ? 'No matches' : 'No shared notes yet'}</li>}
      </ul>
    </aside>
    <section className={`snotes-page${over ? ' over' : ''}`} aria-label={shown?.title || 'Note'}
      onDragOver={e => { if (note && e.dataTransfer.types.includes('Files')) { e.preventDefault(); setOver(true) } }}
      onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(false) }}
      onDrop={e => { e.preventDefault(); setOver(false); void attach([...e.dataTransfer.files].map(f => window.term.files.pathFor(f)).filter(Boolean)) }}>
      {error && <p className="todo-error" role="alert">{error}</p>}
      {!shown ? <div className="snotes-empty"><p>Pick a note, or make a new one.</p><button className="btn" onClick={() => void create()}>New note</button></div> : <>
        <div className="snotes-head">
          <span>{note && `Edited ${ago(note.updatedAt)}${note.updatedByName ? ` by ${note.updatedByName.split(' ')[0]}` : ''}`}</span>
          <button className="todo-link" onClick={() => void window.term.workspace.pickFiles().then(attach)}>Add files…</button>
          {asking ? <><span className="snotes-ask">Delete for everyone?</span>
            <button className="todo-link danger" onClick={() => void remove()}>Delete</button>
            <button className="todo-link" onClick={() => setAsking(false)}>Keep</button></>
            : <button className="todo-link" onClick={() => setAsking(true)}>Delete</button>}
        </div>
        <input ref={title} className="snotes-title" aria-label="Title" value={shown.title} maxLength={500}
          onChange={e => save({ ...shown, title: e.target.value })} />
        <textarea className="snotes-body" aria-label="Note" placeholder="Write here. Drop files anywhere on the note." value={shown.body} maxLength={100000}
          onChange={e => save({ ...shown, body: e.target.value })} />
        {(files.length > 0 || uploading > 0) && <ul className="snotes-files" aria-label="Files">
          {files.map(f => <li key={f.id}>
            <button className="snotes-file" title={`Open ${f.name}`} onClick={() => void show(f)}>
              <b>{kindOf(f)}</b><span>{f.name}</span><small>{size(f.size)}</small></button>
            <button className="todo-icon" aria-label={`Show ${f.name} in Finder`} title="Show in Finder" onClick={() => void show(f, true)}>
              <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 5h4l1 1.5h7V13H2z" /></svg></button>
            <button className="todo-icon" aria-label={`Remove ${f.name}`} title="Remove from the note" onClick={() => void detach(f)}>
              <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg></button>
          </li>)}
          {uploading > 0 && <li className="snotes-uploading">Adding {uploading} file{uploading > 1 ? 's' : ''}…</li>}
        </ul>}
        {over && <div className="snotes-drop">Drop to add to this note</div>}
      </>}
    </section>
  </div>
}
