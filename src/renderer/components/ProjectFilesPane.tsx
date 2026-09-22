import { useRef, useState, type JSX } from 'react'
import type { ProjectListing, ProjectPreview } from '../../shared/project-files'

export function ProjectFilesPane({ side, onSide, onClose }: { side: 'left' | 'right'; onSide: () => void; onClose: () => void }): JSX.Element {
  const [listing, setListing] = useState<ProjectListing | null>(null)
  const [preview, setPreview] = useState<ProjectPreview | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const request = useRef(0)
  const load = async (path: string) => {
    const id = ++request.current; setBusy(true); setError('')
    try { const result = await window.term.project.list(path); if (request.current === id) { setListing(result); setPreview(null) } }
    catch (e) { if (request.current === id) setError(String(e)) }
    finally { if (request.current === id) setBusy(false) }
  }
  const choose = async () => {
    try { if (await window.term.project.choose()) await load('') } catch (e) { setError(String(e)) }
  }
  const open = async (path: string) => {
    const id = ++request.current; setBusy(true); setError(''); setPreview(null)
    try { const result = await window.term.project.preview(path); if (request.current === id) setPreview(result) }
    catch (e) { if (request.current === id) setError(String(e)) }
    finally { if (request.current === id) setBusy(false) }
  }
  return <aside className="project-files-pane" aria-label="Project files">
    <div className="files-toolbar"><strong>Files</strong><button className="btn" onClick={() => void choose()}>Choose folder</button><button className="btn" onClick={onSide} title={`Move files ${side === 'left' ? 'right' : 'left'}`} aria-label={`Move files ${side === 'left' ? 'right' : 'left'}`}>{side === 'left' ? '⇥' : '⇤'}</button><button className="btn" onClick={onClose} aria-label="Close files">×</button></div>
    {listing && <div className="files-path" title={listing.root}>{listing.root.split('/').pop()}/{listing.path}</div>}
    <div role="status" className="files-status">{error || (busy ? 'Loading…' : !listing ? 'Choose a project folder. Files are read-only.' : 'Read-only · symbolic links excluded')}</div>
    {listing && <div className="files-body">
      <nav className="files-tree" aria-label="Project directory">
        {listing.path && <button onClick={() => void load(listing.path.split('/').slice(0, -1).join('/'))}>↰ Parent folder</button>}
        <button onClick={() => void load(listing.path)} aria-label="Refresh files">↻ Refresh</button>
        {listing.entries.map(entry => <button key={entry.path} title={entry.name} aria-label={`${entry.directory ? 'Open folder' : 'Preview file'} ${entry.name}`} aria-pressed={!entry.directory && preview?.path === entry.path} onClick={() => void (entry.directory ? load(entry.path) : open(entry.path))}>{entry.directory ? '▸ ' : '· '}{entry.name}</button>)}
        {listing.truncated && <p>Showing first 500 entries.</p>}
      </nav>
      <section className="file-preview" aria-label="File preview">
        {preview ? <><div className="file-preview-title">{preview.path}</div>{preview.type === 'image' ? <img src={preview.content} alt={preview.path} /> : <pre tabIndex={0}>{preview.content}</pre>}</> : <p>Select a file to preview.</p>}
      </section>
    </div>}
  </aside>
}
