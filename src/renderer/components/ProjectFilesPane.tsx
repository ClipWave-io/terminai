import { lazy, Suspense, useEffect, useRef, useState, type JSX } from 'react'
import type { ProjectListing, ProjectPreview } from '../../shared/project-files'
const errorMessage = (error: unknown) => String(error).replace(/^Error: Error invoking remote method '[^']+': Error: /, '').replace(/^Error: /, '')
const CodeEditor = lazy(()=>import('./CodeEditor'))

export function ProjectFilesPane({ side, onSide, onClose, onDirty, openRequest }: { openRequest?: string | null; side: 'left' | 'right'; onSide: () => void; onClose: () => void; onDirty: (dirty: boolean) => void }): JSX.Element {
  const [listing, setListing] = useState<ProjectListing | null>(null)
  const [preview, setPreview] = useState<ProjectPreview | null>(null)
  const [draft, setDraft] = useState('')
  const dirty = preview?.type === 'text' && draft !== preview.content
  useEffect(() => { onDirty(Boolean(dirty)); return () => onDirty(false) }, [dirty, onDirty])
  useEffect(() => {
    const prevent = (event: BeforeUnloadEvent) => { if (dirty) { event.preventDefault(); event.returnValue = '' } }
    window.addEventListener('beforeunload', prevent); return () => window.removeEventListener('beforeunload', prevent)
  }, [dirty])
  const discard = () => !dirty || window.confirm('Discard unsaved changes to this file?')
  async function save() {
    if (!preview?.version || !dirty || busy) return
    setBusy(true); setError('')
    try { const result = await window.term.project.save(preview.path, draft, preview.version); setPreview(result); setDraft(result.content) }
    catch (e) { setError(errorMessage(e)) }
    finally { setBusy(false) }
  }
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const request = useRef(0)
  const handledOpen = useRef<string | null>(null)
  useEffect(()=>{
    if(!openRequest || handledOpen.current===openRequest || busy)return
    if(!discard()){handledOpen.current=openRequest;return}
    handledOpen.current=openRequest
    setBusy(true);setError('');setPreview(null);setListing(null)
    void window.term.project.open(openRequest).then(result=>{setListing(result.listing);setPreview(result.preview);setDraft(result.preview.content)}).catch(e=>setError(errorMessage(e))).finally(()=>setBusy(false))
  },[openRequest,busy])
  const load = async (path: string, confirmed = false) => {
    if (busy || (!confirmed && !discard())) return
    const id = ++request.current; setBusy(true); setError('')
    try { const result = await window.term.project.list(path); if (request.current === id) { setListing(result); setPreview(null) } }
    catch (e) { if (request.current === id) setError(errorMessage(e)) }
    finally { if (request.current === id) setBusy(false) }
  }
  const choose = async () => {
    if (busy || !discard()) return
    try { if (await window.term.project.choose()) { setPreview(null); setListing(null); setDraft(''); await load('', true) } } catch (e) { setError(errorMessage(e)) }
  }
  const open = async (path: string) => {
    if (busy || !discard()) return
    const id = ++request.current; setBusy(true); setError(''); setPreview(null)
    try { const result = await window.term.project.preview(path); if (request.current === id) { setPreview(result); setDraft(result.content) } }
    catch (e) { if (request.current === id) setError(errorMessage(e)) }
    finally { if (request.current === id) setBusy(false) }
  }
  return <aside className="project-files-pane" aria-label="Project files">
    <div className="files-toolbar"><strong>Files</strong><button className="btn" onClick={() => void choose()}>Choose folder</button><button className="btn" onClick={onSide} title={`Move files ${side === 'left' ? 'right' : 'left'}`} aria-label={`Move files ${side === 'left' ? 'right' : 'left'}`}>{side === 'left' ? '⇥' : '⇤'}</button><button className="btn" onClick={() => { if (!busy && discard()) onClose() }} aria-label="Close files">×</button></div>
    {listing && <div className="files-path" title={listing.root}>{listing.root.split('/').pop()}/{listing.path}</div>}
    <div role="status" className="files-status">{error || (busy ? 'Loading…' : !listing ? 'Choose a project folder to edit text files.' : 'Text editor · ⌘S to save')}</div>
    {listing && <div className="files-body">
      <nav className="files-tree" aria-label="Project directory">
        {listing.path && <button onClick={() => void load(listing.path.split('/').slice(0, -1).join('/'))}>↰ Parent folder</button>}
        <button onClick={() => void load(listing.path)} aria-label="Refresh files">↻ Refresh</button>
        {listing.entries.map(entry => <button key={entry.path} title={entry.name} aria-label={`${entry.directory ? 'Open folder' : 'Open file'} ${entry.name}`} aria-pressed={!entry.directory && preview?.path === entry.path} onClick={() => void (entry.directory ? load(entry.path) : open(entry.path))}>{entry.directory ? '▸ ' : '· '}{entry.name}</button>)}
        {listing.truncated && <p>Showing first 500 entries.</p>}
      </nav>
      <section className="file-preview" aria-label="File preview">
        {preview ? <><div className="file-preview-title">{preview.path}{dirty ? ' • Unsaved' : ''}{preview.type === 'text' && <button className="btn" disabled={!dirty || busy} onClick={()=>void save()}>Save ⌘S</button>}</div>{preview.type === 'image' ? <img src={preview.content} alt={preview.path} /> : <Suspense fallback={<p>Opening editor…</p>}><CodeEditor path={preview.path} value={draft} readOnly={busy} onChange={setDraft} onSave={()=>void save()}/></Suspense>}</> : <p>Select a text file to edit, or an image to preview.</p>}
      </section>
    </div>}
  </aside>
}
