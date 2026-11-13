import { lazy, Suspense, useEffect, useRef, useState, type JSX, type MouseEvent as ReactMouseEvent } from 'react'
import type { ProjectListing, ProjectPreview } from '../../shared/project-files'
const errorMessage = (error: unknown) => String(error).replace(/^Error: Error invoking remote method '[^']+': Error: /, '').replace(/^Error: /, '')
const PdfViewer = lazy(()=>import('./PdfViewer'))
const CodeEditor = lazy(()=>import('./CodeEditor'))

export function ProjectFilesPane({ side, onSide, onClose, onDirty, openRequest, full, onFull }: { full?: boolean; onFull?: () => void; openRequest?: string | null; side: 'left' | 'right'; onSide: () => void; onClose: () => void; onDirty: (dirty: boolean) => void }): JSX.Element {
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
  /** A name being typed in the list: a rename in place, or a new file or folder (in `path`, the folder). */
  const [naming, setNaming] = useState<{ kind: 'rename' | 'new-file' | 'new-folder'; path: string; name: string } | null>(null)
  // Finder's right-click menu; it comes from the main process, native.
  const menu = async (event: ReactMouseEvent, path: string, directory: boolean, background = false) => {
    event.preventDefault(); event.stopPropagation()
    if (!listing || busy) return
    const result = await window.term.project.menu(path, directory, background).catch(e => { setError(errorMessage(e)); return null })
    if (!result) return
    if (result.action === 'error') setError(result.path ?? 'That did not work.')
    else if (result.action === 'refresh') void load(listing.path, true)
    else if (result.action === 'open') void (directory ? load(path) : open(path))
    else if (result.action === 'rename') setNaming({ kind: 'rename', path, name: path.split('/').pop() ?? '' })
    else if (result.action === 'new-file' || result.action === 'new-folder') {
      const folder = result.path ?? ''
      if (folder !== listing.path) await load(folder, true)
      setNaming({ kind: result.action, path: folder, name: result.action === 'new-folder' ? 'untitled folder' : 'untitled.txt' })
    }
  }
  const finishNaming = async (keep: boolean) => {
    const was = naming; setNaming(null)
    if (!keep || !was || !listing || !was.name.trim()) return
    try {
      const made = was.kind === 'rename' ? await window.term.project.rename(was.path, was.name) : await window.term.project.create(was.path, was.name, was.kind === 'new-folder')
      await load(listing.path, true)
      if (was.kind === 'new-file') void open(made)
    } catch (e) { setError(errorMessage(e)) }
  }
  const nameField = () => naming && <input className="files-name" aria-label={naming.kind === 'rename' ? 'New name' : naming.kind === 'new-folder' ? 'Folder name' : 'File name'}
    value={naming.name} autoFocus spellCheck={false} onChange={e => setNaming({ ...naming, name: e.target.value })}
    onFocus={e => { const dot = naming.kind === 'new-folder' ? -1 : e.target.value.lastIndexOf('.'); e.target.setSelectionRange(0, dot > 0 ? dot : e.target.value.length) }}
    onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void finishNaming(true) } else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); void finishNaming(false) } }}
    onBlur={() => void finishNaming(true)} />
  // The file list and the preview: drag the line between them to give either more room (kept on this Mac). The list sits
  // above the preview in a narrow pane and beside it in a wide one, so the line moves up and down or left and right.
  const [treeSize, setTreeSize] = useState<{ h?: number; w?: number }>(() => { try { return JSON.parse(localStorage.getItem('files:tree') || '{}') } catch { return {} } })
  const dragTree = (e: ReactMouseEvent<HTMLDivElement>) => {
    const nav = e.currentTarget.previousElementSibling as HTMLElement | null, parent = nav?.parentElement; if (!nav || !parent) return
    e.preventDefault()
    const row = getComputedStyle(parent).flexDirection === 'row', start = row ? e.clientX : e.clientY, box = nav.getBoundingClientRect(), outer = parent.getBoundingClientRect()
    const size0 = row ? box.width : box.height, max = (row ? outer.width : outer.height) - 140
    const move = (m: MouseEvent) => { const v = Math.round(Math.min(max, Math.max(row ? 120 : 60, size0 + (row ? m.clientX : m.clientY) - start))); setTreeSize(s => row ? { ...s, w: v } : { ...s, h: v }) }
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); setTreeSize(s => { try { localStorage.setItem('files:tree', JSON.stringify(s)) } catch {} return s }) }
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up)
  }
  return <aside className="project-files-pane" aria-label="Project files">
    <div className="files-toolbar"><strong>Files</strong><button className="btn" onClick={() => void choose()}>Choose folder</button>{listing && <button className="btn" title="Open this folder in Finder" aria-label="Open in Finder" onClick={() => void window.term.project.openFolder(listing.path)}><svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M1.5 12.5v-9a1 1 0 0 1 1-1h3.2a1 1 0 0 1 .7.3l1 1a1 1 0 0 0 .7.3h5.4a1 1 0 0 1 1 1v7.4a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1Z" fill="none" stroke="currentColor" strokeWidth="1.3" /></svg></button>}{onFull && <button className="btn" onClick={onFull} title={full ? 'Back to the sessions  Esc' : 'Show the file full size'} aria-label={full ? 'Exit full size' : 'Full size'} aria-pressed={full}>{full ? '⤡' : '⤢'}</button>}<button className="btn" onClick={onSide} title={`Move files ${side === 'left' ? 'right' : 'left'}`} aria-label={`Move files ${side === 'left' ? 'right' : 'left'}`}>{side === 'left' ? '⇥' : '⇤'}</button><button className="btn" onClick={() => { if (!busy && discard()) onClose() }} aria-label="Close files">×</button></div>
    {listing && <div className="files-path" title={listing.root}>{listing.root.split('/').pop()}/{listing.path}</div>}
    <div role="status" className="files-status">{/EPERM|EACCES|not permitted/.test(error) ? <span className="files-perm">macOS hasn’t allowed TerminAI into this folder yet. Turn on TerminAI under Files and Folders (or Full Disk Access), then open the folder again.<button className="btn" onClick={() => void window.term.project.privacy()}>Open Privacy Settings</button></span> : error || (busy ? 'Loading…' : !listing ? 'Choose a project folder to edit text files.' : preview?.type === 'pdf' ? 'PDF viewer' : preview && preview.type !== 'text' ? 'Preview' : 'Text editor · ⌘S to save')}</div>
    {listing && <div className="files-body">
      <nav className="files-tree" aria-label="Project directory" style={{ ['--tree-h' as string]: treeSize.h ? `${treeSize.h}px` : undefined, ['--tree-w' as string]: treeSize.w ? `${treeSize.w}px` : undefined }} data-sized={treeSize.h ? 'h' : undefined} data-wide={treeSize.w ? 'w' : undefined} onContextMenu={e => void menu(e, listing.path, true, true)}>
        {naming && naming.kind !== 'rename' && nameField()}
        {listing.path && <button onClick={() => void load(listing.path.split('/').slice(0, -1).join('/'))}>↰ Parent folder</button>}
        <button onClick={() => void load(listing.path)} aria-label="Refresh files">↻ Refresh</button>
        {listing.entries.map(entry => naming?.kind === 'rename' && naming.path === entry.path ? <span key={entry.path}>{nameField()}</span> : <button key={entry.path} title={entry.name} onContextMenu={e => void menu(e, entry.path, entry.directory)} aria-label={`${entry.directory ? 'Open folder' : 'Open file'} ${entry.name}`} aria-pressed={!entry.directory && preview?.path === entry.path} onClick={() => void (entry.directory ? load(entry.path) : open(entry.path))}>{entry.directory ? '▸ ' : '· '}{entry.name}</button>)}
        {listing.truncated && <p>Showing first 500 entries.</p>}
      </nav>
      <div className="files-split" role="separator" aria-orientation="horizontal" aria-label="Resize the file list" title="Drag to resize · double-click to reset" onMouseDown={dragTree} onDoubleClick={() => { setTreeSize({}); try { localStorage.removeItem('files:tree') } catch {} }} />
      <section className="file-preview" aria-label="File preview">
        {preview ? <><div className="file-preview-title">{preview.path}{dirty ? ' • Unsaved' : ''}{preview.type === 'text' && <button className="btn" disabled={!dirty || busy} onClick={()=>void save()}>Save ⌘S</button>}{preview.type !== 'text' && preview.type !== 'pdf' && <button className="btn" title="Open it in the app macOS uses for this kind of file" onClick={()=>void window.term.project.openExternal(preview.path).catch(e=>setError(errorMessage(e)))}>Open with the default app</button>}</div>{preview.type === 'pdf' ? <Suspense fallback={<p>Opening PDF…</p>}><PdfViewer content={preview.content}
          onOpen={()=>void window.term.project.openExternal(preview.path).catch(e=>setError(errorMessage(e)))}
          onReveal={()=>void window.term.project.reveal(preview.path).catch(e=>setError(errorMessage(e)))}
          onCopyPath={()=>void window.term.project.reveal(preview.path).then(p=>navigator.clipboard.writeText(p)).catch(e=>setError(errorMessage(e)))}
          onFull={onFull} /></Suspense> : preview.type === 'image' ? <img src={preview.content} alt={preview.path} /> : preview.type === 'html' ? <iframe className="file-html" sandbox="" srcDoc={preview.content} title={preview.path} /> : preview.type === 'video' ? <video className="file-media" controls src={preview.content} /> : preview.type === 'audio' ? <audio className="file-media" controls src={preview.content} /> : preview.type === 'none' ? <p>{preview.content}</p> : <Suspense fallback={<p>Opening editor…</p>}><CodeEditor path={preview.path} value={draft} readOnly={busy} onChange={setDraft} onSave={()=>void save()}/></Suspense>}</> : <p>Select a file: text opens in the editor, everything else as a preview.</p>}
      </section>
    </div>}
  </aside>
}
