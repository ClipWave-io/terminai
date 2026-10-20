import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { JSX } from 'react'
import type { Task, TaskInput, TaskList, TaskScope, TasksUser } from '../../shared/types'
import './todos.css'

type Assignee = Task['assignee']
type Save = (scope: TaskScope, input: TaskInput) => Promise<TaskList | null>
/** A row typed but not saved yet. `after` keeps it, and the task it becomes, under the row where Enter was pressed. */
type Pending = { key: string; scope: TaskScope; section: string; title: string; assignee: Assignee; after: string | null }
type Layout = { pending: Pending[]; placed: Record<string, string>; draft: { section: string; after: string } | null }
type MenuItem = { label: string; checked?: boolean; danger?: boolean; run: () => void } | { heading: string } | { input: string; placeholder: string; run: (value: string) => void } | null
/** `up`: where the menu's bottom goes when it does not fit below `y` (the top of the button that opened it). */
type Menu = { x: number; y: number; up?: number; items: MenuItem[] }
type Row = { kind: 'task'; task: Task } | { kind: 'pending'; pending: Pending } | { kind: 'draft' }

/** Livio is Matteo in the BUILD note; the files keep the id 'livio'. */
const NAME = { livio: 'Matteo', ilai: 'Ilai' } as const
const SECTIONS: { assignee: Assignee; key: string; label: string }[] = [{ assignee: 'both', key: 'both', label: 'Together' }, { assignee: 'livio', key: 'livio', label: 'Matteo' }, { assignee: 'ilai', key: 'ilai', label: 'Ilai' }, { assignee: null, key: 'none', label: 'Unassigned' }]
const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
const rome = (iso: string, opts: Intl.DateTimeFormatOptions) => new Date(iso).toLocaleString('de-DE', { timeZone: 'Europe/Rome', ...opts })
const day = (iso: string) => rome(iso, { day: '2-digit', month: '2-digit', year: 'numeric' })
const clock = (iso: string) => rome(iso, { hour: '2-digit', minute: '2-digit' })
// The 39 tasks imported from BUILD share one createdAt: the id breaks the tie and, unlike the title, never changes.
const byCreated = (a: Task, b: Task) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
const byDone = (a: Task, b: Task) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)
const rowKey = (row: Row) => row.kind === 'task' ? row.task.id : row.kind === 'pending' ? row.pending.key : 'draft'

/** createdAt order, then what was added this session put back under the row where Enter was pressed. */
function arrange(tasks: Task[], layout: Layout, scope: TaskScope, section: string): Row[] {
  const rows: Row[] = tasks.filter(task => !layout.placed[task.id]).map(task => ({ kind: 'task', task }))
  const put = (row: Row, after: string | null) => { const at = after ? rows.findIndex(r => rowKey(r) === after) : -1; rows.splice(at < 0 ? rows.length : at + 1, 0, row) }
  for (const [id, after] of Object.entries(layout.placed)) { const task = tasks.find(t => t.id === id); if (task) put({ kind: 'task', task }, after) }
  for (const pending of layout.pending) if (pending.scope === scope && pending.section === section) put({ kind: 'pending', pending }, pending.after)
  if (layout.draft?.section === section) put({ kind: 'draft' }, layout.draft.after)
  return rows
}

/** A saved pending row becomes task `id` (or, when the save failed, hands its place back): every anchor on it moves. */
function settle(layout: Layout, key: string, id: string | null): Layout {
  const own = layout.pending.find(p => p.key === key), to = id ?? own?.after ?? null
  const swap = (anchor: string | null) => anchor === key ? to : anchor
  const placed: Record<string, string> = {}
  for (const [task, anchor] of Object.entries(layout.placed)) { const next = swap(anchor); if (next) placed[task] = next }
  if (id && own?.after) placed[id] = own.after
  const draftAfter = layout.draft && swap(layout.draft.after)
  return { pending: layout.pending.filter(p => p.key !== key).map(p => ({ ...p, after: swap(p.after) })), placed, draft: layout.draft && draftAfter ? { ...layout.draft, after: draftAfter } : null }
}

/** Personal to-dos (this Mac only) and shared ones (the build-tasks repo) as one note each, like the BUILD note in Apple Notes. */
export function TodoSheet({ user, onUser, onClose }: { user: TasksUser | ''; onUser: (user: TasksUser) => void; onClose: () => void }): JSX.Element {
  const [data, setData] = useState<TaskList | null>(null)
  const [scope, setScope] = useState<TaskScope>('shared')
  const [showDone, setShowDone] = useState(false)
  const [error, setError] = useState('')
  const [layout, setLayout] = useState<Layout>({ pending: [], placed: {}, draft: null })
  const [confirm, setConfirm] = useState<string | null>(null)
  const [noteFor, setNoteFor] = useState<string | null>(null)
  const [menu, setMenu] = useState<Menu | null>(null)
  const seq = useRef(0)
  const sheet = useRef<HTMLElement>(null)

  useEffect(() => {
    sheet.current?.focus()
    let stopped = false
    const refresh = () => void window.term.todos.list().then(value => { if (!stopped) setData(value) }).catch(err => setError(errorText(err)))
    refresh()
    // Sent by the main process around every pull and push, including the 3-minute sync.
    const off = window.term.todos.onChanged(refresh)
    return () => { stopped = true; off() }
  }, [])
  // Focus falls back to the page when the row it was in goes away (checked, deleted) or a field is left with Esc: Esc must still close.
  useEffect(() => {
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape' && !event.defaultPrevented && document.activeElement === document.body) onClose() }
    addEventListener('keydown', key)
    return () => removeEventListener('keydown', key)
  }, [onClose])

  async function act(work: () => Promise<TaskList>): Promise<TaskList | null> {
    setError('')
    try { const value = await work(); setData(value); return value } catch (err) { setError(errorText(err)); return null }
  }
  const save: Save = (target, input) => act(() => window.term.todos.save(target, input))
  const remove = async (target: TaskScope, id: string) => !!(await act(() => window.term.todos.remove(target, id)))

  /** Shows the row at once and clears the field, so the next task can be typed while git commits and pushes this one. */
  async function add(section: string, assignee: Assignee, title: string, fromDraft: boolean) {
    const key = `new-${++seq.current}`, target = scope, known = new Set((data?.[target] ?? []).map(task => task.id))
    setLayout(l => ({ ...l, pending: [...l.pending, { key, scope: target, section, title, assignee, after: fromDraft ? l.draft?.after ?? null : null }], draft: fromDraft && l.draft ? { ...l.draft, after: key } : l.draft }))
    let made: Task | undefined
    try {
      const value = await window.term.todos.save(target, { title, assignee })
      setData(value)
      made = value[target].filter(task => !known.has(task.id) && task.title === title).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0]
    } catch (err) { setError(`Could not add “${title}”: ${errorText(err)}`) }
    setLayout(l => settle(l, key, made?.id ?? null))
  }

  function openMenu(task: Task, x: number, y: number, up?: number) {
    const set = (input: Omit<TaskInput, 'id'>) => () => void save(scope, { id: task.id, ...input })
    const items: (MenuItem | false)[] = [
      task.status === 'done' ? { label: 'Reopen', run: set({ status: 'open' }) } : { label: 'Mark done', run: set({ status: 'done' }) },
      task.status !== 'done' && { label: 'In progress', checked: task.status === 'doing', run: set({ status: task.status === 'doing' ? 'open' : 'doing' }) },
      ...(scope === 'shared' ? [null, { heading: 'Assign to' }, ...SECTIONS.map(s => ({ label: s.assignee ? s.label : 'Nobody', checked: task.assignee === s.assignee, run: set({ assignee: s.assignee }) }))] : []),
      null, { heading: 'Product' }, { input: task.product, placeholder: 'e.g. ManyMotions', run: (product: string) => void save(scope, { id: task.id, product }) },
      !task.notes && { label: 'Add note', run: () => setNoteFor(task.id) },
      null, { label: 'Delete…', danger: true, run: () => setConfirm(task.id) },
    ]
    setMenu({ x, y, up, items: items.filter((item): item is MenuItem => item !== false) })
  }

  const sync = data?.sync
  const tasks = data?.[scope] ?? []
  const open = tasks.filter(task => task.status !== 'done').sort(byCreated)
  const done = tasks.filter(task => task.status === 'done').sort(byDone)
  const row = (task: Task, section?: string) => <TaskRow key={task.id} task={task} scope={scope} confirming={confirm === task.id} openNote={noteFor === task.id}
    onSave={save} onRemove={remove} onConfirm={on => setConfirm(on ? task.id : null)} onNoteOpened={() => setNoteFor(null)}
    onMenu={(x, y, up) => openMenu(task, x, y, up)} onEnter={section === undefined ? undefined : () => setLayout(l => ({ ...l, draft: { section, after: task.id } }))} />
  const checklist = (section: string, assignee: Assignee, list: Task[]) => <ul className="todo-check">
    {arrange(list, layout, scope, section).map(item => item.kind === 'task' ? row(item.task, section)
      : item.kind === 'pending' ? <li key={item.pending.key} className="todo-row pending"><span className="todo-circle" /><div className="todo-body"><div className="todo-line"><span className="todo-text">{item.pending.title}</span></div></div></li>
      : <DraftRow key="draft" autoFocus onAdd={title => void add(section, assignee, title, true)} onLeave={how => {
          const anchor = layout.draft?.after
          setLayout(l => ({ ...l, draft: null }))
          const text = how === 'backspace' && anchor ? document.querySelector<HTMLTextAreaElement>(`[data-id="${anchor}"] .todo-text`) : null
          if (text) { text.focus(); text.setSelectionRange(text.value.length, text.value.length) }
        }} />)}
    <DraftRow key="new" placeholder="New task" onAdd={title => void add(section, assignee, title, false)} />
  </ul>
  const sections = scope === 'personal' ? [] : SECTIONS.filter(s => s.assignee !== null || open.some(task => task.assignee === null) || layout.pending.some(p => p.scope === scope && p.section === s.key) || layout.draft?.section === s.key)
  const syncText = !sync ? '' : !sync.enabled ? 'Shared sync is off' : sync.syncing ? 'Syncing…' : sync.error ? 'Sync failed' : sync.lastSync ? `Synced ${clock(sync.lastSync)}` : 'Not synced yet'

  return <div className="workspace-overlay todo-overlay" role="presentation"
    onClick={event => { if (event.target === event.currentTarget) onClose() }}
    onKeyDown={event => { if (event.key === 'Escape' && !event.defaultPrevented) { event.stopPropagation(); onClose() } }}>
    <section ref={sheet} tabIndex={-1} className="todo-sheet" role="dialog" aria-modal="true" aria-label="To-do">
      <header className="todo-head">
        {user && <div className="todo-segment" role="group" aria-label="List">
          <button aria-pressed={scope === 'shared'} onClick={() => setScope('shared')}>Shared</button>
          <button aria-pressed={scope === 'personal'} onClick={() => setScope('personal')}>Personal</button>
        </div>}
        <div className="todo-sync">
          {user && <>
            <span className={sync?.error ? 'failed' : ''} title={sync?.error ?? undefined} aria-live="polite">{syncText}</span>
            <button className="todo-link" disabled={!sync?.enabled || sync.syncing} onClick={() => void act(() => window.term.todos.sync())}>Sync now</button>
            <button className="todo-link" aria-label={`You are ${NAME[user]}`} title="Who you are on this Mac"
              onClick={event => { const b = event.currentTarget.getBoundingClientRect(); setMenu({ x: b.left, y: b.bottom + 4, up: b.top - 4, items: [{ heading: 'You are' }, ...(['livio', 'ilai'] as const).map(name => ({ label: NAME[name], checked: user === name, run: () => onUser(name) }))] }) }}>{NAME[user]}</button>
          </>}
          <button className="todo-close" aria-label="Close to-do" title="Close" onClick={onClose}>×</button>
        </div>
      </header>
      {!user ? <div className="todo-note todo-pick">
        <h1>To-do</h1>
        <p>Who are you on this Mac?</p>
        <div className="todo-who" role="group" aria-label="You are">{(['livio', 'ilai'] as const).map(name => <button key={name} className="btn" onClick={() => onUser(name)}>{NAME[name]}</button>)}</div>
        <p className="todo-muted">Saved on this Mac. It signs every change you make. Shared tasks sync with the other one through the build-tasks repo; personal ones stay here.</p>
      </div> : <article className="todo-note" aria-label={scope === 'shared' ? 'Shared' : 'Personal'}>
        {error && <p className="todo-error" role="alert">{error}</p>}
        {scope === 'shared' && sync?.error && <p className="todo-error" role="alert">Shared sync: {sync.error}</p>}
        <h1>{scope === 'shared' ? 'BUILD' : 'Personal'}</h1>
        {scope === 'shared' ? <>
          <p className="todo-rule">— Status last updated: {sync?.lastSync ? day(sync.lastSync) : 'not synced yet'} —</p>
          <p className="todo-rule">— Priority Tasks —</p>
          {sections.map(s => <section key={s.key} aria-label={s.label}>
            <h3 className={`todo-at ${s.key}`}>{s.assignee ? `@${s.label}` : s.label}</h3>
            {checklist(s.key, s.assignee, open.filter(task => task.assignee === s.assignee))}
          </section>)}
        </> : checklist('personal', null, open)}
        <p className="todo-rule todo-rule-done">— COMPLETED TASKS —</p>
        {!done.length ? <p className="todo-muted">Nothing completed yet.</p> : <>
          <button className="todo-show-done" aria-expanded={showDone} onClick={() => setShowDone(value => !value)}>{showDone ? 'Hide completed' : `Show completed (${done.length})`}</button>
          {showDone && (scope === 'personal' ? <ul className="todo-check">{done.map(task => row(task))}</ul>
            : SECTIONS.map(s => { const list = done.filter(task => task.assignee === s.assignee); return !!list.length && <section key={s.key} aria-label={`${s.label} tasks done`}>
                <h4 className="todo-done-head">{s.label} tasks done</h4>
                <ul className="todo-check">{list.map(task => row(task))}</ul>
              </section> }))}
        </>}
      </article>}
      {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
    </section>
  </div>
}

function TaskRow({ task, scope, confirming, openNote, onSave, onRemove, onConfirm, onNoteOpened, onMenu, onEnter }: {
  task: Task; scope: TaskScope; confirming: boolean; openNote: boolean; onSave: Save; onRemove: (scope: TaskScope, id: string) => Promise<boolean>
  onConfirm: (on: boolean) => void; onNoteOpened: () => void; onMenu: (x: number, y: number, up?: number) => void; onEnter?: () => void
}): JSX.Element {
  const [title, setTitle] = useState(task.title)
  const [notes, setNotes] = useState(task.notes)
  const [noteEditing, setNoteEditing] = useState(false)
  const [checking, setChecking] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const editing = useRef(false)
  const cancel = useRef(false)
  const caret = useRef<number | null>(null)
  const text = useRef<HTMLTextAreaElement>(null)
  // A refresh arrives at the start and end of every git job: it must not overwrite what is being typed.
  useEffect(() => { if (!editing.current) setTitle(task.title) }, [task.title])
  // The note on screen is the local copy too, so a note just written stays while git commits and pushes it.
  useEffect(() => { if (!noteEditing) setNotes(task.notes) }, [task.notes])
  useEffect(() => { if (openNote) { caret.current = notes.length; setNoteEditing(true); onNoteOpened() } }, [openNote])

  function commitTitle() {
    if (cancel.current) { cancel.current = false; return }
    const next = title.trim()
    // An empty title is never saved: Backspace on an empty row asks to delete instead.
    if (!next) return setTitle(task.title)
    if (next !== task.title) void onSave(scope, { id: task.id, title: next }).then(ok => { if (!ok) setTitle(task.title) })
  }
  function commitNotes() {
    setNoteEditing(false)
    if (cancel.current) { cancel.current = false; return }
    const next = notes.trim()
    setNotes(next)
    if (next !== task.notes) void onSave(scope, { id: task.id, notes: next }).then(ok => { if (!ok) setNotes(task.notes) })
  }
  async function check() {
    if (task.status === 'done') return void onSave(scope, { id: task.id, status: 'open' })
    setChecking(true)
    await new Promise(resolve => setTimeout(resolve, 280))
    if (!(await onSave(scope, { id: task.id, status: 'done' }))) setChecking(false)
  }
  const status = checking ? 'done' : task.status

  return <li className={`todo-row ${task.status}${checking ? ' checking' : ''}`} data-id={task.id} onContextMenu={event => { event.preventDefault(); onMenu(event.clientX, event.clientY) }}>
    <button className={`todo-circle ${status}`} aria-label={task.status === 'done' ? 'Reopen' : 'Mark done'} title={task.status === 'done' ? 'Reopen' : task.status === 'doing' ? 'In progress · mark done' : 'Mark done'} onClick={() => void check()}>
      <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5.8 10.4l2.8 2.8 5.6-6" /></svg>
    </button>
    <div className="todo-body">
      <div className="todo-line" onMouseDown={event => { if (event.button === 0 && event.target === event.currentTarget) { event.preventDefault(); const el = text.current!; el.focus(); el.setSelectionRange(el.value.length, el.value.length) } }}>
        <textarea ref={text} className="todo-text" rows={1} value={title} maxLength={300} aria-label="Task" spellCheck={false}
          onFocus={() => { editing.current = true }}
          onChange={event => setTitle(event.target.value.replace(/\n/g, ' '))}
          onBlur={() => { editing.current = false; commitTitle() }}
          onKeyDown={event => {
            if (event.nativeEvent.isComposing) return
            if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); onEnter?.() }
            else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancel.current = true; setTitle(task.title); event.currentTarget.blur() }
            else if (event.key === 'Backspace' && !title) { event.preventDefault(); onConfirm(true) }
          }} />
        {task.status === 'doing' && <span className="todo-tag doing">in progress</span>}
        {task.product && <span className="todo-tag">{task.product}</span>}
      </div>
      {noteEditing
        ? <textarea className="todo-notes" value={notes} maxLength={20000} aria-label="Note" placeholder="Note" spellCheck={false}
            ref={el => { if (el && caret.current !== null) { el.focus(); el.setSelectionRange(caret.current, caret.current); caret.current = null } }}
            onChange={event => setNotes(event.target.value)} onBlur={commitNotes}
            onKeyDown={event => {
              if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancel.current = true; setNotes(task.notes); event.currentTarget.blur() }
              else if (event.key === 'Enter' && event.metaKey) { event.preventDefault(); event.currentTarget.blur() }
            }} />
        : notes && <div className="todo-note-text" role="button" tabIndex={0} aria-label="Edit note"
            onMouseDown={event => { const range = document.caretRangeFromPoint(event.clientX, event.clientY); caret.current = range && event.currentTarget.contains(range.startContainer) ? range.startOffset : notes.length; event.preventDefault(); setNoteEditing(true) }}
            onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); caret.current = notes.length; setNoteEditing(true) } }}>{notes}</div>}
      {confirming && <div className="todo-confirm" role="group" aria-label="Confirm delete"
        onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onConfirm(false) } }}>
        Delete this task?
        <button className="danger" autoFocus disabled={deleting} onClick={async () => { setDeleting(true); if (await onRemove(scope, task.id)) onConfirm(false); else setDeleting(false) }}>Delete</button>
        <button onClick={() => onConfirm(false)}>Keep</button>
      </div>}
    </div>
    <span className="todo-actions">
      {!notes && !noteEditing && <button className="todo-icon" title="Add note" onClick={() => { caret.current = 0; setNoteEditing(true) }}>+ Note</button>}
      <button className="todo-icon" aria-label="Task actions" title="More" onClick={event => { const b = event.currentTarget.getBoundingClientRect(); onMenu(b.right - 200, b.bottom + 4, b.top - 4) }}>•••</button>
    </span>
  </li>
}

/** The empty line at the end of a section, or the one Enter opens under a row. Enter adds and keeps typing. */
function DraftRow({ placeholder = '', autoFocus, onAdd, onLeave }: { placeholder?: string; autoFocus?: boolean; onAdd: (title: string) => void; onLeave?: (how: 'blur' | 'empty' | 'escape' | 'backspace') => void }): JSX.Element {
  const [title, setTitle] = useState('')
  const cancel = useRef(false)
  const submit = () => { const next = title.trim(); if (next) { onAdd(next); setTitle('') } return !!next }
  const leave = (el: HTMLTextAreaElement, how: 'empty' | 'escape' | 'backspace') => { cancel.current = true; el.blur(); onLeave?.(how) }
  return <li className="todo-row draft">
    <span className="todo-circle" aria-hidden="true" />
    <div className="todo-body"><div className="todo-line">
      <textarea className="todo-text" rows={1} value={title} maxLength={300} placeholder={placeholder} aria-label={placeholder || 'New task'} autoFocus={autoFocus} spellCheck={false}
        onChange={event => setTitle(event.target.value.replace(/\n/g, ' '))}
        onBlur={() => { if (cancel.current) { cancel.current = false; return } submit(); onLeave?.('blur') }}
        onKeyDown={event => {
          if (event.nativeEvent.isComposing) return
          if (event.key === 'Enter') { event.preventDefault(); if (!submit() && onLeave) leave(event.currentTarget, 'empty') }
          else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setTitle(''); leave(event.currentTarget, 'escape') }
          else if (event.key === 'Backspace' && !title && onLeave) { event.preventDefault(); leave(event.currentTarget, 'backspace') }
        }} />
    </div></div>
  </li>
}

/** Right click or "•••" on a row. Not a native menu: Esc and a click outside close it, the arrows move through it. */
function ContextMenu({ menu, onClose }: { menu: Menu; onClose: () => void }): JSX.Element {
  const box = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: menu.x, top: menu.y })
  useLayoutEffect(() => {
    const b = box.current!.getBoundingClientRect()
    // Flipped above rather than pushed up, so it never lands under the pointer that opened it.
    setPos({ left: Math.max(8, Math.min(menu.x, innerWidth - b.width - 8)), top: menu.y + b.height <= innerHeight - 8 ? menu.y : Math.max(8, (menu.up ?? menu.y) - b.height) })
    box.current!.querySelector<HTMLElement>('button, input')?.focus()
  }, [menu])
  useEffect(() => {
    const down = (event: MouseEvent) => { if (!box.current?.contains(event.target as Node)) onClose() }
    addEventListener('mousedown', down, true)
    return () => removeEventListener('mousedown', down, true)
  }, [onClose])
  return <div ref={box} className="todo-menu" role="menu" style={pos} onKeyDown={event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose() }
    else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const items = [...box.current!.querySelectorAll<HTMLElement>('button, input')], at = items.indexOf(document.activeElement as HTMLElement)
      items[(at + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus()
    }
  }}>
    {menu.items.map((item, i) => !item ? <hr key={i} />
      : 'heading' in item ? <div key={i} className="todo-menu-head">{item.heading}</div>
      : 'input' in item ? <MenuInput key={i} value={item.input} placeholder={item.placeholder} onDone={value => { onClose(); item.run(value) }} />
      : <button key={i} role={item.checked === undefined ? 'menuitem' : 'menuitemcheckbox'} aria-checked={item.checked} className={item.danger ? 'danger' : ''} onClick={() => { onClose(); item.run() }}>{item.label}</button>)}
  </div>
}

function MenuInput({ value, placeholder, onDone }: { value: string; placeholder: string; onDone: (value: string) => void }): JSX.Element {
  const [text, setText] = useState(value)
  return <input className="todo-menu-input" aria-label="Product" placeholder={placeholder} value={text} maxLength={100} spellCheck={false}
    onChange={event => setText(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); onDone(text) } }} />
}
