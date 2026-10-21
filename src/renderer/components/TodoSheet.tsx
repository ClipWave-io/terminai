import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { JSX } from 'react'
import type { Task, TaskInput, TaskList, TaskScope, TasksUser } from '../../shared/types'
import { TodoHistory, when } from './TodoHistory'
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
/** One checklist in a column: where its rows are saved and where a row typed into it goes. */
type Part = { scope: TaskScope; section: string; assignee: Assignee; label?: string; list: Task[]; placeholder?: string }
type Column = { key: string; label: string; parts: Part[]; done: { task: Task; scope: TaskScope }[] }
/** Where a task is at one point of the undo history; null: it does not exist (deleted, or not made yet). */
type Snap = { scope: TaskScope; task: Task } | null
/** One action, undone and redone as a whole: every task it changed, before and after. */
type Step = { id: string; before: Snap; after: Snap }[]
/** ⌘X moves the tasks on ⌘V, ⌘C duplicates them; ids in the order their rows were on screen. */
type Clip = { ids: string[]; mode: 'cut' | 'copy' }
/** Where ⌘V puts the clipboard: after task `after` of `part`, or at its top when null. */
type Spot = { part: Part; after: string | null }

/** Livio is Matteo in the BUILD note; the files keep the id 'livio'. */
const NAME = { livio: 'Matteo', ilai: 'Ilai' } as const
/** Completed tasks shown per column before "Show all". */
const DONE_SHOWN = 5
/** Steps ⌘Z can go back. */
const UNDO_STEPS = 50
const SECOND = 1000, HOUR = 3_600_000
const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
const rome = (iso: string, opts: Intl.DateTimeFormatOptions) => new Date(iso).toLocaleString('de-DE', { timeZone: 'Europe/Rome', ...opts })
const clock = (iso: string) => rome(iso, { hour: '2-digit', minute: '2-digit' })
/** A task's place in its list: where it was pasted, otherwise when it was created. */
const rank = (task: Task) => task.order ?? Date.parse(task.createdAt)
// The 39 tasks imported from BUILD share one createdAt: the id breaks the tie and, unlike the title, never changes.
const byOrder = (a: Task, b: Task) => rank(a) - rank(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
const byDone = (a: Task, b: Task) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)
const rowKey = (row: Row) => row.kind === 'task' ? row.task.id : row.kind === 'pending' ? row.pending.key : 'draft'
function find(list: TaskList | null, id: string): Snap {
  for (const scope of ['shared', 'personal'] as const) { const task = list?.[scope].find(t => t.id === id); if (task) return { scope, task } }
  return null
}
const same = (a: Snap, b: Snap) => {
  const key = (snap: Snap) => JSON.stringify(snap && [snap.scope, Object.entries(snap.task).filter(([, value]) => value !== undefined).sort(([x], [y]) => x < y ? -1 : 1)])
  return key(a) === key(b)
}
const Chevron = () => <svg className="todo-chevron" viewBox="0 0 12 12" aria-hidden="true"><path d="M3 4.5l3 3 3-3" /></svg>
const Lock = () => <svg className="todo-lock" viewBox="0 0 16 16" aria-hidden="true"><rect x="3.5" y="7.2" width="9" height="6.3" rx="1.6" /><path d="M5.6 7.2V5.4a2.4 2.4 0 0 1 4.8 0v1.8" /></svg>

/** Their order (see rank), then what was added this session put back under the row where Enter was pressed. */
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

/**
 * New orders for `moving` put at index `at` of `rows` (a part as shown, without them), for them and for the
 * neighbours that have to move with them. The gap between two rows is shared out; with no gap left (the tasks
 * imported from BUILD all have one createdAt) the whole part is renumbered a second apart from its first rank,
 * so tasks created later still sort below. Tasks placed this session under a row (`loose`, shown out of their
 * order) are renumbered too, so they stay where they are on screen.
 */
function orders(rows: Task[], moving: Task[], at: number, loose: Set<string>): { task: Task; order: number; moved: boolean }[] {
  const seq = [...rows.slice(0, at), ...moving, ...rows.slice(at)], moved = (i: number) => i >= at && i < at + moving.length
  const span = seq.flatMap((task, i) => moved(i) || loose.has(task.id) ? [i] : [])
  const lo = Math.min(...span), hi = Math.max(...span) + 1, n = hi - lo
  const a = lo > 0 ? rank(seq[lo - 1]) : -Infinity, b = hi < seq.length ? rank(seq[hi]) : Infinity
  if (b - a < n + 1) { const base = Math.min(...seq.map(rank)); return seq.map((task, i) => ({ task, order: base + i * SECOND, moved: moved(i) })) }
  return seq.slice(lo, hi).map((task, i) => ({ task, moved: moved(lo + i), order:
    a === -Infinity ? (b === Infinity ? Date.now() + i * SECOND : b - (n - i) * HOUR) : b === Infinity ? a + (i + 1) * HOUR : a + (b - a) * (i + 1) / (n + 1) }))
}

/**
 * The BUILD note of Apple Notes in four columns: mine, Together and the other one's (all shared, in the
 * build-tasks repo, mirrored on the other Mac), then my private notes, kept on this Mac only.
 */
export function TodoSheet({ user, onUser, onClose }: { user: TasksUser | ''; onUser: (user: TasksUser) => void; onClose: () => void }): JSX.Element {
  const [data, setData] = useState<TaskList | null>(null)
  const [allDone, setAllDone] = useState<Record<string, boolean>>({})
  const [error, setError] = useState('')
  const [layout, setLayout] = useState<Layout>({ pending: [], placed: {}, draft: null })
  // The shared task whose row asks "Make it private?" (the other one loses sight of it).
  const [confirm, setConfirm] = useState<string | null>(null)
  const [noteFor, setNoteFor] = useState<string | null>(null)
  const [menu, setMenu] = useState<Menu | null>(null)
  const [view, setView] = useState<'shared' | 'private'>('shared')
  const [sel, setSel] = useState<string[]>([])
  const [clip, setClip] = useState<Clip | null>(null)
  /** The tasks the delete question is about. */
  const [ask, setAsk] = useState<string[] | null>(null)
  // An object, so a second "Deleted 3 tasks" restarts the 8 seconds.
  const [toast, setToast] = useState<{ text: string } | null>(null)
  /** The shared task whose history is open. */
  const [history, setHistory] = useState<Task | null>(null)
  // App.tsx mounts the top bar slot in the same commit, so it is looked up once the sheet is in the DOM.
  const [slot, setSlot] = useState<HTMLElement | null | undefined>(undefined)
  useLayoutEffect(() => setSlot(document.getElementById('todo-topbar-slot')), [])
  const seq = useRef(0)
  const sheet = useRef<HTMLElement>(null)
  // What the main process last returned: the undo history reads it between renders.
  const latest = useRef<TaskList | null>(null)
  const undos = useRef<Step[]>([]), redos = useRef<Step[]>([])
  const queue = useRef<Promise<unknown>>(Promise.resolve())
  /** The row ⇧-click selects from, and the column ⌘A selects. */
  const anchor = useRef<string | null>(null), lastCol = useRef<string | null>(null)
  const keys = useRef<(event: KeyboardEvent) => void>(() => {})
  const show = (value: TaskList) => { latest.current = value; setData(value) }
  const focusSheet = () => sheet.current?.focus({ preventScroll: true })

  useEffect(() => {
    sheet.current?.focus()
    let stopped = false
    const refresh = () => void window.term.todos.list().then(value => { if (!stopped) show(value) }).catch(err => setError(errorText(err)))
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
  // Before the rows and the overlay see them: ⌘Z, ⌘X, ⌘V… on the tasks (keys.current says when).
  useEffect(() => {
    const key = (event: KeyboardEvent) => keys.current(event)
    addEventListener('keydown', key, true)
    return () => removeEventListener('keydown', key, true)
  }, [])
  // Text cut or copied in a field takes the clipboard's place: the next ⌘V pastes that text, not the tasks.
  useEffect(() => {
    const drop = (event: Event) => { if (event.target instanceof Element && event.target.closest('textarea, input')) setClip(null) }
    addEventListener('cut', drop)
    addEventListener('copy', drop)
    return () => { removeEventListener('cut', drop); removeEventListener('copy', drop) }
  }, [])
  // A task deleted elsewhere (the other Mac, through a sync) leaves the selection and the clipboard.
  useEffect(() => {
    if (!data) return
    const live = (id: string) => !!find(data, id)
    setSel(ids => ids.every(live) ? ids : ids.filter(live))
    setClip(c => !c || c.ids.every(live) ? c : c.ids.some(live) ? { ...c, ids: c.ids.filter(live) } : null)
  }, [data])
  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(() => setToast(null), 8000)
    return () => clearTimeout(timer)
  }, [toast])

  async function act(work: () => Promise<TaskList>): Promise<TaskList | null> {
    setError('')
    try { const value = await work(); show(value); return value } catch (err) { setError(errorText(err)); return null }
  }
  /** One change at a time, so ⌘Z always finds the step of the change made before it. */
  function serial<T>(work: () => Promise<T>): Promise<T> {
    const run = queue.current.then(work)
    queue.current = run.catch(() => {})
    return run
  }
  /** What `ids` were in `then` and are now, as one step of undo. */
  function remember(then: TaskList | null, ids: string[]): Step | null {
    const step = [...new Set(ids)].flatMap(id => { const before = find(then, id), after = find(latest.current, id); return same(before, after) ? [] : [{ id, before, after }] })
    if (!step.length) return null
    undos.current = [...undos.current, step].slice(-UNDO_STEPS)
    redos.current = []
    setToast(null)
    return step
  }
  const save: Save = (target, input) => serial(async () => {
    const then = latest.current, value = await act(() => window.term.todos.save(target, input))
    if (input.id) remember(then, [input.id])
    return value
  })
  const move = (from: TaskScope, id: string, assignee?: Assignee) => serial(async () => {
    const then = latest.current, ok = !!(await act(() => window.term.todos.move(from, id, assignee)))
    remember(then, [id])
    return ok
  })

  /** Shows the row at once and clears the field, so the next task can be typed while git commits and pushes this one. */
  async function add(target: TaskScope, section: string, assignee: Assignee, title: string, fromDraft: boolean) {
    const key = `new-${++seq.current}`, known = new Set((data?.[target] ?? []).map(task => task.id))
    setLayout(l => ({ ...l, pending: [...l.pending, { key, scope: target, section, title, assignee, after: fromDraft ? l.draft?.after ?? null : null }], draft: fromDraft && l.draft ? { ...l.draft, after: key } : l.draft }))
    const made = await serial(async () => {
      const then = latest.current
      try {
        const value = await window.term.todos.save(target, { title, assignee })
        show(value)
        const task = value[target].filter(t => !known.has(t.id) && t.title === title).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0]
        if (task) remember(then, [task.id])
        return task
      } catch (err) { setError(`Could not add “${title}”: ${errorText(err)}`); return undefined }
    })
    setLayout(l => settle(l, key, made?.id ?? null))
  }

  /** ⌘V: the cut tasks move to `spot` (another column, private ⇄ shared, or up and down their own), copied ones are duplicated there. */
  const paste = ({ part, after }: Spot) => serial(async () => {
    const then = latest.current, take = clip
    const movers = (take?.ids ?? []).flatMap(id => { const snap = find(then, id); return snap ? [snap] : [] })
    if (!then || !take || !movers.length) return
    const cut = take.mode === 'cut', away = new Set(cut ? take.ids : [])
    const shown = arrange(open(part.scope === 'personal' ? then.personal : then.shared.filter(task => task.assignee === part.assignee)), layout, part.scope, part.section).flatMap(row => row.kind === 'task' ? [row.task] : [])
    const rows = shown.filter(task => !away.has(task.id)), upto = shown.findIndex(task => task.id === after)
    // Pasted next to a task that is itself moving: after the last one before it that stays.
    const at = after === null ? 0 : upto < 0 ? rows.length : shown.slice(0, upto + 1).filter(task => !away.has(task.id)).length
    const loose = new Set(rows.filter(task => layout.placed[task.id]).map(task => task.id))
    const to = part.scope === 'shared' ? part.assignee : null
    const inputs: TaskInput[] = [], moves: { from: TaskScope; id: string; order: number }[] = []
    let next = 0
    for (const { task, order, moved } of orders(rows, movers.map(snap => snap.task), at, loose)) {
      if (!moved) { if (rank(task) !== order) inputs.push({ id: task.id, order }); continue }
      const from = movers[next++]!.scope
      if (!cut) inputs.push({ title: task.title, notes: task.notes, status: task.status, product: task.product, assignee: to, order })
      else if (from !== part.scope) moves.push({ from, id: task.id, order })
      else inputs.push({ id: task.id, order, ...(part.scope === 'personal' || task.assignee === to ? {} : { assignee: to }) })
    }
    // Their place now comes from their order, not from the row they were typed under.
    setLayout(l => ({ ...l, placed: Object.fromEntries(Object.entries(l.placed).filter(([id]) => !away.has(id) && !loose.has(id))) }))
    let ok = true
    for (const m of moves) ok = ok && !!(await act(() => window.term.todos.move(m.from, m.id, to, m.order)))
    if (ok && inputs.length) ok = !!(await act(() => window.term.todos.saveMany(part.scope, inputs)))
    const copies = cut ? [] : (latest.current?.[part.scope] ?? []).filter(task => !find(then, task.id) && movers.some(snap => snap.task.title === task.title)).map(task => task.id)
    remember(then, [...moves.map(m => m.id), ...inputs.flatMap(input => input.id ?? []), ...copies])
    if (cut && ok) setClip(null)
    const landed = cut ? movers.map(snap => snap.task.id) : copies
    setSel(landed)
    anchor.current = landed[0] ?? null
  })

  /** The delete question answered: one commit for the shared ones, then "Deleted N tasks · Undo". */
  const deleteTasks = (ids: string[]) => serial(async () => {
    const then = latest.current, gone = ids.flatMap(id => { const snap = find(then, id); return snap ? [snap] : [] })
    for (const scope of ['shared', 'personal'] as const) {
      const some = gone.filter(snap => snap.scope === scope).map(snap => snap.task.id)
      if (some.length && !(await act(() => window.term.todos.removeMany(scope, some)))) break
    }
    const step = remember(then, gone.map(snap => snap.task.id))
    setAsk(null)
    setSel([])
    focusSheet()
    if (step) setToast({ text: `Deleted ${step.length} task${step.length === 1 ? '' : 's'}` })
  })

  /** ⌘Z, and ⇧⌘Z to redo: every task of the last step back where it was, private or shared, with its very same file. */
  const undo = (redo = false) => serial(async () => {
    const step = (redo ? redos : undos).current.pop()
    if (!step) return
    const from = (c: Step[number]) => redo ? c.before : c.after, to = (c: Step[number]) => redo ? c.after : c.before
    // Changed since by someone else (the other Mac, through a sync): going back would throw that away.
    const changed = step.find(c => !same(find(latest.current, c.id), from(c)))
    if (changed) return setError(`Can’t ${redo ? 'redo' : 'undo'}: “${(changed.after ?? changed.before)?.task.title}” changed since.`)
    let ok = true
    // Private ⇄ shared through the move that never leaves a task nowhere, then the exact copies, then away what did not exist.
    for (const c of step) {
      const here = from(c), there = to(c)
      if (ok && here && there && here.scope !== there.scope) ok = !!(await act(() => window.term.todos.move(here.scope, c.id, there.task.assignee)))
    }
    for (const scope of ['shared', 'personal'] as const) {
      const put = step.flatMap(c => { const there = to(c); return there?.scope === scope ? [there.task] : [] })
      const drop = step.flatMap(c => !to(c) && from(c)?.scope === scope ? [c.id] : [])
      if (ok && put.length) ok = !!(await act(() => window.term.todos.restore(scope, put)))
      if (ok && drop.length) ok = !!(await act(() => window.term.todos.removeMany(scope, drop)))
    }
    if (ok) (redo ? undos : redos).current.push(step)
    setToast(null)
    const back = step.flatMap(c => to(c) ? [c.id] : [])
    setSel(back)
    anchor.current = back[0] ?? null
  })

  /** Ids in the order their rows are on screen; ones not on screen are left out. */
  const inOrder = (ids: string[]) => [...document.querySelectorAll<HTMLElement>('.todo-row[data-id]')].map(row => row.dataset.id!).filter(id => ids.includes(id))
  /** ⌘-click adds a row to the selection or takes it out; ⇧-click selects from the last ⌘-clicked row, in its column. */
  function select(id: string, how: 'toggle' | 'range') {
    const col = document.querySelector(`.todo-row[data-id="${id}"]`)?.closest<HTMLElement>('.todo-col')
    const ids = [...(col?.querySelectorAll<HTMLElement>('.todo-row[data-id]') ?? [])].map(row => row.dataset.id!)
    lastCol.current = col?.dataset.col ?? null
    focusSheet()
    if (how === 'range' && anchor.current && ids.includes(anchor.current)) {
      const [first, last] = [ids.indexOf(anchor.current), ids.indexOf(id)].sort((x, y) => x - y)
      return setSel(ids.slice(first, last + 1))
    }
    anchor.current = id
    setSel(s => s.includes(id) ? s.filter(x => x !== id) : [...s, id])
  }

  const me: TasksUser = user || 'livio', other: TasksUser = me === 'livio' ? 'ilai' : 'livio'
  const unseen = data?.unseen ?? []
  // Looking at what changed is what makes the "edited by" mark go.
  function openHistory(task: Task) {
    setHistory(task)
    void window.term.todos.markSeen([task.id]).then(show).catch(err => setError(errorText(err)))
  }
  const label = (assignee: Assignee) => assignee === 'both' ? 'Together' : assignee ? NAME[assignee] : 'Unassigned'

  function openMenu(task: Task, scope: TaskScope, x: number, y: number, up?: number) {
    // On one of several selected rows the menu is about all of them.
    const group = sel.length > 1 && sel.includes(task.id) ? inOrder(sel) : null
    if (group) return setMenu({ x, y, up, items: [{ heading: `${group.length} tasks` }, { label: 'Cut', run: () => { setClip({ ids: group, mode: 'cut' }); setSel([]) } },
      { label: 'Copy', run: () => setClip({ ids: group, mode: 'copy' }) }, null, { label: `Delete ${group.length} tasks…`, danger: true, run: () => setAsk(group) }] })
    if (!sel.includes(task.id)) setSel([])
    const set = (input: Omit<TaskInput, 'id'>) => () => void save(scope, { id: task.id, ...input })
    const share = (assignee: Assignee) => () => void move('personal', task.id, assignee)
    const items: (MenuItem | false)[] = [
      task.status === 'done' ? { label: 'Reopen', run: set({ status: 'open' }) } : { label: 'Mark done', run: set({ status: 'done' }) },
      task.status !== 'done' && { label: 'In progress', checked: task.status === 'doing', run: set({ status: task.status === 'doing' ? 'open' : 'doing' }) },
      // A private task that goes to another column becomes shared on the way.
      ...(scope === 'personal'
        ? [null, { label: 'Make shared', run: share(me) }, { heading: 'Move to' }, ...(['both', other] as const).map(a => ({ label: label(a), run: share(a) }))]
        : [null, { heading: 'Move to' }, ...([me, 'both', other] as const).map(a => ({ label: label(a), checked: task.assignee === a, run: set({ assignee: a }) })), { label: 'Make private…', run: () => setConfirm(task.id) }]),
      null, { heading: 'Product' }, { input: task.product, placeholder: 'e.g. ManyMotions', run: (product: string) => void save(scope, { id: task.id, product }) },
      !task.notes && { label: 'Add note', run: () => setNoteFor(task.id) },
      { label: 'Add image…', run: () => void act(() => window.term.todos.pickImages(scope, task.id)) },
      scope === 'shared' && { label: 'History…', run: () => openHistory(task) },
      null, { label: 'Delete…', danger: true, run: () => setAsk([task.id]) },
    ]
    setMenu({ x, y, up, items: items.filter((item): item is MenuItem => item !== false) })
  }

  const sync = data?.sync
  const personal = data?.personal ?? [], shared = data?.shared ?? []
  const open = (list: Task[]) => list.filter(task => task.status !== 'done').sort(byOrder)
  const done = (list: Task[], scope: TaskScope) => list.filter(task => task.status === 'done').map(task => ({ task, scope }))
  const to = (assignee: Assignee) => shared.filter(task => task.assignee === assignee)
  const columns: Column[] = [
    { key: me, label: NAME[me], parts: [{ scope: 'shared', section: me, assignee: me, list: open(to(me)), placeholder: 'New task' }], done: done(to(me), 'shared') },
    { key: 'both', label: 'Together', parts: [
      { scope: 'shared', section: 'both', assignee: 'both', list: open(to('both')), placeholder: 'New task' },
      { scope: 'shared', section: 'none', assignee: null, label: 'Unassigned', list: open(to(null)) },
    ], done: [...done(to('both'), 'shared'), ...done(to(null), 'shared')] },
    { key: other, label: NAME[other], parts: [{ scope: 'shared', section: other, assignee: other, list: open(to(other)), placeholder: 'New task' }], done: done(to(other), 'shared') },
  ]
  // Private notes stay on this Mac, one file per person: the other one never sees them.
  const privateNotes: Column = { key: 'private', label: 'Private', parts: [{ scope: 'personal', section: 'private', assignee: null, list: open(personal), placeholder: 'New private note' }], done: done(personal, 'personal') }
  const shownColumns = view === 'private' ? [privateNotes] : columns
  const pick = (event: { currentTarget: HTMLElement }, items: MenuItem[]) => { const b = event.currentTarget.getBoundingClientRect(); setMenu({ x: b.left, y: b.bottom + 4, up: b.top - 4, items }) }
  const row = (task: Task, scope: TaskScope, section?: string, lock = false) => <TaskRow key={task.id} task={task} scope={scope} lock={lock} other={NAME[other]}
    fresh={scope === 'shared' && unseen.includes(task.id) ? { by: NAME[task.updatedBy as TasksUser] ?? task.updatedBy, at: task.updatedAt, added: task.createdAt === task.updatedAt } : null} onHistory={() => openHistory(task)}
    confirming={confirm === task.id} openNote={noteFor === task.id} selected={sel.includes(task.id)} cut={clip?.mode === 'cut' && clip.ids.includes(task.id)}
    onSave={save} onImage={act} onLeave={onClose} onPrivate={() => move('shared', task.id)} onConfirm={on => setConfirm(on ? task.id : null)} onDelete={() => setAsk([task.id])} onNoteOpened={() => setNoteFor(null)}
    onSelect={how => select(task.id, how)} onMenu={(x, y, up) => openMenu(task, scope, x, y, up)} onEnter={section === undefined ? undefined : () => setLayout(l => ({ ...l, draft: { section, after: task.id } }))} />
  const checklist = ({ scope, section, assignee, list, placeholder }: Part) => <ul className="todo-check">
    {arrange(list, layout, scope, section).map(item => item.kind === 'task' ? row(item.task, scope, section)
      : item.kind === 'pending' ? <li key={item.pending.key} className="todo-row pending"><span className="todo-circle" /><div className="todo-body"><div className="todo-line"><span className="todo-text">{item.pending.title}</span></div></div></li>
      : <DraftRow key="draft" autoFocus onAdd={title => void add(scope, section, assignee, title, true)} onLeave={how => {
          const anchor = layout.draft?.after
          setLayout(l => ({ ...l, draft: null }))
          const text = how === 'backspace' && anchor ? document.querySelector<HTMLTextAreaElement>(`[data-id="${anchor}"] .todo-text`) : null
          if (text) { text.focus(); text.setSelectionRange(text.value.length, text.value.length) }
        }} />)}
    {placeholder && <DraftRow key="new" placeholder={placeholder} onAdd={title => void add(scope, section, assignee, title, false)} />}
  </ul>
  // A part with no "New task" row (Unassigned) shows only while it has rows.
  const shown = (part: Part) => !!part.placeholder || !!part.list.length || layout.pending.some(p => p.scope === part.scope && p.section === part.section) || layout.draft?.section === part.section
  /** Newest first, so a task just ticked lands at the top. */
  const completed = (col: Column) => {
    const list = [...col.done].sort((a, b) => byDone(a.task, b.task)), all = allDone[col.key] || list.length <= DONE_SHOWN
    return !!list.length && <section className="todo-done" aria-label={`${col.label} tasks done`}>
      <h4 className="todo-done-head">{col.label} tasks done</h4>
      <ul className="todo-check">{(all ? list : list.slice(0, DONE_SHOWN)).map(({ task, scope }) => row(task, scope))}</ul>
      {list.length > DONE_SHOWN && <button className="todo-show-done" aria-expanded={all} onClick={() => setAllDone(value => ({ ...value, [col.key]: !all }))}>{all ? 'Show fewer' : `Show all (${list.length})`}</button>}
    </section>
  }
  /** Where ⌘V goes from a row: after a task, after the last task above a "New task" row, at the end of the part a completed task belongs to. */
  function spotOf(li: Element | null): Spot | null {
    const col = li?.closest<HTMLElement>('.todo-col'), box = li?.closest<HTMLElement>('.todo-part')
    const parts = shownColumns.find(c => c.key === col?.dataset.col)?.parts ?? []
    if (!li || !col) return null
    if (box) {
      const part = parts.find(p => p.section === box.dataset.part)
      let above: Element | null = li
      while (above && !above.matches('[data-id]')) above = above.previousElementSibling
      return part ? { part, after: above instanceof HTMLElement ? above.dataset.id ?? null : null } : null
    }
    const snap = find(latest.current, li instanceof HTMLElement ? li.dataset.id ?? '' : '')
    const part = snap && parts.find(p => p.scope === snap.scope && (p.scope === 'personal' || p.assignee === snap.task.assignee))
    if (!part) return null
    const last = [...col.querySelectorAll<HTMLElement>(`.todo-part[data-part="${part.section}"] .todo-row[data-id]`)].pop()
    return { part, after: last?.dataset.id ?? null }
  }
  /** ⌘V in a field pastes the tasks only on a row's title left as it is or an empty "New task" row; once something is typed, the text. */
  function spotIn(field: HTMLElement): Spot | null {
    const li = field.closest<HTMLElement>('.todo-row'), value = field instanceof HTMLTextAreaElement ? field.value : ''
    if (!li || !field.matches('.todo-text')) return null
    if (li.dataset.id ? value !== find(latest.current, li.dataset.id)?.task.title : value) return null
    return spotOf(li)
  }
  /** ⌘A: every open task of the column last clicked or focused, mine when none. */
  function selectColumn() {
    const key = shownColumns.some(c => c.key === lastCol.current) ? lastCol.current : shownColumns[0]?.key
    const ids = [...document.querySelectorAll<HTMLElement>(`.todo-col[data-col="${key}"] .todo-part .todo-row[data-id]`)].map(r => r.dataset.id!)
    setSel(ids)
    anchor.current = ids[0] ?? null
  }
  keys.current = event => {
    if (event.isComposing || menu || ask || !user) return
    const el = document.activeElement instanceof HTMLElement ? document.activeElement : null
    // The "Make private" question under a row keeps its own keys.
    if (el?.closest('.todo-confirm')) return
    const field = !!el?.matches('textarea, input, select, [contenteditable="true"]'), cmd = event.metaKey && !event.ctrlKey && !event.altKey, k = event.key.toLowerCase()
    const take = (work: () => void) => { event.preventDefault(); event.stopPropagation(); work() }
    if (cmd && k === 'v' && clip) {
      const last = inOrder(sel).pop(), spot = field && el ? spotIn(el) : last ? spotOf(document.querySelector(`.todo-row[data-id="${last}"]`)) : null
      if (spot) take(() => { focusSheet(); void paste(spot) })
      return
    }
    // In a field ⌘Z, ⌘X, ⌘C and ⌘A stay the text's own.
    if (field) return
    if (cmd && k === 'z') take(() => void undo(event.shiftKey))
    else if (cmd && k === 'a') take(selectColumn)
    else if (cmd && (k === 'x' || k === 'c') && sel.length) take(() => { setClip({ ids: inOrder(sel), mode: k === 'x' ? 'cut' : 'copy' }); if (k === 'x') setSel([]) })
    else if ((event.key === 'Backspace' || event.key === 'Delete') && !event.metaKey && sel.length) take(() => setAsk(inOrder(sel)))
    else if (event.key === 'Escape' && (sel.length || clip)) take(() => { setSel([]); setClip(null) })
  }
  const syncText = !sync ? '' : !sync.enabled ? 'Shared sync is off' : sync.syncing ? 'Syncing…' : sync.error ? 'Sync failed' : sync.lastSync ? `Synced ${clock(sync.lastSync)}` : 'Not synced yet'

  return <div className="workspace-overlay todo-overlay" role="presentation"
    onClick={event => { if (event.target === event.currentTarget) onClose() }}
    onKeyDown={event => { if (event.key === 'Escape' && !event.defaultPrevented) { event.stopPropagation(); onClose() } }}>
    <section ref={sheet} tabIndex={-1} className="todo-sheet" role="dialog" aria-modal="true" aria-label="To-do"
      onFocus={event => { const col = event.target instanceof Element && event.target.closest<HTMLElement>('.todo-col'); if (col) lastCol.current = col.dataset.col ?? null }}
      // A plain click anywhere (editing a row, an empty spot) drops the selection; ⌘- and ⇧-clicks on rows never get here,
      // and "•••" on a selected row opens the menu for all of them.
      onMouseDown={event => { if (event.button === 0 && sel.length && !(event.target instanceof Element && event.target.closest('.todo-menu, .sheet-backdrop, .todo-toast, .todo-actions'))) setSel([]) }}>
      {(() => {
        // The controls sit in the middle of the app's top bar while the to-do is open (App.tsx keeps
        // the slot); inline above the columns only if the slot is missing.
        const controls = <div className="todo-sync">
          {user && <>
            <button className="todo-drop" aria-label={`Showing ${view} tasks`} title="Shared tasks or your private notes"
              onClick={event => pick(event, [{ heading: 'Show' }, { label: 'Shared', checked: view === 'shared', run: () => setView('shared') }, { label: 'Private (only on this Mac)', checked: view === 'private', run: () => setView('private') }])}>
              {view === 'private' && <Lock />}{view === 'private' ? 'Private' : 'Shared'}<Chevron /></button>
            <button className="todo-drop" aria-label={`You are ${NAME[user]}`} title="Who you are on this Mac"
              onClick={event => pick(event, [{ heading: 'You are' }, ...(['livio', 'ilai'] as const).map(name => ({ label: NAME[name], checked: user === name, run: () => onUser(name) }))])}>{NAME[user]}<Chevron /></button>
            <span className={sync?.error ? 'failed' : ''} title={sync?.error ?? undefined} aria-live="polite">{syncText}</span>
            <button className="todo-link" disabled={!sync?.enabled || sync.syncing} onClick={() => void act(() => window.term.todos.sync())}>Sync now</button>
            {view === 'shared' && unseen.length > 0 && <button className="todo-link todo-unseen" title="Each changed task carries its mark; this clears them all"
              onClick={() => void act(() => window.term.todos.markSeen(unseen))}>{unseen.length} changed by {NAME[other]} · Mark all seen</button>}
          </>}
        </div>
        return slot ? createPortal(controls, slot) : slot === null && <header className="todo-head">{controls}</header>
      })()}
      {!user ? <div className="todo-note todo-pick">
        <h1>To-do</h1>
        <p>Who are you on this Mac?</p>
        <div className="todo-who" role="group" aria-label="You are">{(['livio', 'ilai'] as const).map(name => <button key={name} className="btn" onClick={() => onUser(name)}>{NAME[name]}</button>)}</div>
        <p className="todo-muted">Saved on this Mac. It signs every change you make. Shared tasks sync with the other one through the build-tasks repo; private ones stay here.</p>
      </div> : <article className="todo-note" aria-label="BUILD">
        {error && <p className="todo-error" role="alert">{error}</p>}
        {sync?.error && <p className="todo-error" role="alert">Shared sync: {sync.error}</p>}
        <div className={`todo-cols${view === 'private' ? ' single' : ''}`}>
          {shownColumns.map(col => <section key={col.key} className="todo-col" aria-label={col.label} data-col={col.key}>
            <h3 className={`todo-at ${col.key}`} title={col.key === 'private' ? 'Only on this Mac' : undefined}>{col.key === 'private' && <Lock />}{col.label.toUpperCase()}</h3>
            {col.parts.filter(shown).map(part => <div key={part.section} className="todo-part" data-part={part.section} role="group" aria-label={part.label ?? col.label}>
              {part.label && <h4 className="todo-sub">{part.scope === 'personal' && <Lock />}{part.label}</h4>}
              {checklist(part)}
            </div>)}
            {completed(col)}
          </section>)}
        </div>
      </article>}
      {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
      {history && <TodoHistory task={history} onClose={() => { setHistory(null); focusSheet() }} />}
      {ask && <DeleteDialog titles={ask.flatMap(id => find(data, id)?.task.title ?? [])} onCancel={() => { setAsk(null); focusSheet() }} onDelete={() => void deleteTasks(ask)} />}
      {toast && <div className="todo-toast" role="status">{toast.text}<span aria-hidden="true">·</span><button onClick={() => void undo()}>Undo</button></div>}
    </section>
  </div>
}

/**
 * `lock`: a private task in a list that mixes both (my completed ones). `other`: who loses a task made private.
 * `confirming`: the row asks "Make it private?"; deleting is asked by the sheet (onDelete).
 */
function TaskRow({ task, scope, lock, other, fresh, onHistory, confirming, openNote, selected, cut, onSave, onImage, onLeave, onPrivate, onConfirm, onDelete, onNoteOpened, onSelect, onMenu, onEnter }: {
  task: Task; scope: TaskScope; lock: boolean; other: string; confirming: boolean; openNote: boolean; selected: boolean; cut: boolean; onSave: Save
  /** Adding or removing an image, with the sheet's error line. */
  onImage: (work: () => Promise<TaskList>) => Promise<TaskList | null>
  /** Closes the sheet, for an image sent to the Files pane behind it. */
  onLeave: () => void
  /** Changed by the other person since this one last looked: who, when, and whether it is a new task. */
  fresh: { by: string; at: string; added: boolean } | null; onHistory: () => void
  onPrivate: () => Promise<boolean>; onConfirm: (on: boolean) => void; onDelete: () => void; onNoteOpened: () => void; onSelect: (how: 'toggle' | 'range') => void
  onMenu: (x: number, y: number, up?: number) => void; onEnter?: () => void
}): JSX.Element {
  const [title, setTitle] = useState(task.title)
  const [notes, setNotes] = useState(task.notes)
  const [noteEditing, setNoteEditing] = useState(false)
  const [checking, setChecking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [dropping, setDropping] = useState(false)
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
  // A screenshot pasted into the title or the note, or pictures dropped on the row, go under the note.
  const pictures = (files: FileList) => [...files].filter(file => file.type.startsWith('image/') || /\.(heic|heif)$/i.test(file.name))
  const addPictures = (files: File[]) => { for (const file of files) void onImage(async () => window.term.todos.addImage(scope, task.id, await file.arrayBuffer())) }
  const pasteImages = (event: React.ClipboardEvent) => {
    const files = pictures(event.clipboardData.files)
    if (!files.length) return
    event.preventDefault()
    addPictures(files)
  }
  const status = checking ? 'done' : task.status
  // ⌘-click and ⇧-click select the row: no editing, no tick. ⇧-click inside the text being edited still extends its selection.
  const picking = (event: { button: number; metaKey: boolean; shiftKey: boolean; target: EventTarget }) => event.button === 0 && (event.metaKey || (event.shiftKey && event.target !== document.activeElement))

  return <li className={`todo-row ${task.status}${checking ? ' checking' : ''}${selected ? ' selected' : ''}${cut ? ' cut' : ''}${fresh ? ' fresh' : ''}${dropping ? ' dropping' : ''}`} data-id={task.id}
    onDragOver={event => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; setDropping(true) } }}
    onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropping(false) }}
    onDrop={event => { setDropping(false); const files = pictures(event.dataTransfer.files); if (files.length) { event.preventDefault(); addPictures(files) } }}
    onMouseDownCapture={event => { if (picking(event)) { event.preventDefault(); event.stopPropagation(); onSelect(event.shiftKey ? 'range' : 'toggle') } }}
    onClickCapture={event => { if (picking(event)) { event.preventDefault(); event.stopPropagation() } }}
    onContextMenu={event => { event.preventDefault(); onMenu(event.clientX, event.clientY) }}>
    <button className={`todo-circle ${status}`} aria-label={task.status === 'done' ? 'Reopen' : 'Mark done'} title={task.status === 'done' ? 'Reopen' : task.status === 'doing' ? 'In progress · mark done' : 'Mark done'} onClick={() => void check()}>
      <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5.8 10.4l2.8 2.8 5.6-6" /></svg>
    </button>
    <div className="todo-body">
      <div className="todo-line" onMouseDown={event => { if (event.button === 0 && event.target === event.currentTarget) { event.preventDefault(); const el = text.current!; el.focus(); el.setSelectionRange(el.value.length, el.value.length) } }}>
        <textarea ref={text} className="todo-text" rows={1} value={title} maxLength={300} aria-label="Task" spellCheck={false}
          onFocus={() => { editing.current = true }}
          onChange={event => setTitle(event.target.value.replace(/\n/g, ' '))}
          onPaste={pasteImages}
          onBlur={() => { editing.current = false; commitTitle() }}
          onKeyDown={event => {
            if (event.nativeEvent.isComposing) return
            if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); onEnter?.() }
            else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancel.current = true; setTitle(task.title); event.currentTarget.blur() }
            else if (event.key === 'Backspace' && !title) { event.preventDefault(); onDelete() }
          }} />
        {task.status === 'doing' && <span className="todo-tag doing">in progress</span>}
        {task.product && <span className="todo-tag">{task.product}</span>}
        {lock && <span className="todo-tag" title="Private" aria-label="Private"><Lock /></span>}
        {fresh && <button className="todo-tag todo-fresh" title="See what changed" onClick={onHistory}>{fresh.added ? 'new' : 'edited'} by {fresh.by} · {when(fresh.at)}</button>}
      </div>
      {noteEditing
        ? <textarea className="todo-notes" value={notes} maxLength={20000} aria-label="Note" placeholder="Note" spellCheck={false}
            ref={el => { if (el && caret.current !== null) { el.focus(); el.setSelectionRange(caret.current, caret.current); caret.current = null } }}
            onChange={event => setNotes(event.target.value)} onBlur={commitNotes} onPaste={pasteImages}
            onKeyDown={event => {
              if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancel.current = true; setNotes(task.notes); event.currentTarget.blur() }
              else if (event.key === 'Enter' && event.metaKey) { event.preventDefault(); event.currentTarget.blur() }
            }} />
        : notes && <div className="todo-note-text" role="button" tabIndex={0} aria-label="Edit note"
            onMouseDown={event => { const range = document.caretRangeFromPoint(event.clientX, event.clientY); caret.current = range && event.currentTarget.contains(range.startContainer) ? range.startOffset : notes.length; event.preventDefault(); setNoteEditing(true) }}
            onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); caret.current = notes.length; setNoteEditing(true) } }}>{notes}</div>}
      {!!task.images?.length && <div className="todo-images">
        {task.images.map(name => <TaskImage key={name} scope={scope} id={task.id} name={name} onLeave={onLeave} onRemove={() => void onImage(() => window.term.todos.removeImage(scope, task.id, name))} />)}
      </div>}
      {confirming && <div className="todo-confirm" role="group" aria-label="Confirm make private"
        onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onConfirm(false) } }}>
        Make it private? {other} will no longer see it.
        <button className="primary" autoFocus disabled={busy} onClick={async () => { setBusy(true); if (await onPrivate()) onConfirm(false); else setBusy(false) }}>Make private</button>
        <button onClick={() => onConfirm(false)}>Keep shared</button>
      </div>}
    </div>
    <span className="todo-actions">
      <button className="todo-icon" aria-label="Task actions" title="More" onClick={event => { const b = event.currentTarget.getBoundingClientRect(); onMenu(b.right - 200, b.bottom + 4, b.top - 4) }}>•••</button>
    </span>
  </li>
}

/** A picture under a task's note: a click shows it whole over the sheet, × takes it off the task. */
function TaskImage({ scope, id, name, onRemove, onLeave }: { scope: TaskScope; id: string; name: string; onRemove: () => void; onLeave: () => void }): JSX.Element {
  const [src, setSrc] = useState<string | null>(null)
  const [full, setFull] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    void window.term.todos.imageThumb(scope, id, name).then(url => { if (live) setSrc(url) }, () => { if (live) setSrc('') })
    return () => { live = false }
  }, [scope, id, name])
  const view = () => { setFull(''); void window.term.todos.imageFull(scope, id, name).then(setFull, () => setFull(null)) }
  const close = () => setFull(null)
  return <span className="todo-image">
    {src ? <button className="todo-image-open" title="View" onClick={view}><img src={src} alt="" /></button>
      : <span className="todo-image-missing">{src === '' ? 'Not synced yet' : ''}</span>}
    <button className="todo-image-remove" aria-label="Remove image" title="Remove image" onClick={onRemove}>×</button>
    {full !== null && createPortal(<div className="todo-lightbox" role="dialog" aria-modal="true" aria-label="Image" tabIndex={-1} ref={el => el?.focus()}
      onMouseDown={event => { if (event.target === event.currentTarget) close() }}
      onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close() } }}>
      {full ? <img src={full} alt="" /> : <span className="todo-muted">Loading…</span>}
      <div className="todo-lightbox-bar">
        <button className="btn" onClick={() => void window.term.todos.showImage(scope, id, name).then(() => { close(); onLeave() }, () => {})}>Open in the Files pane</button>
        <button className="btn primary" autoFocus onClick={close}>Close</button>
      </div>
    </div>, document.body)}
  </span>
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

/** Deleting, asked in the app and never with window.confirm: Delete has the focus (Enter), Esc or Cancel keeps the tasks. */
function DeleteDialog({ titles, onCancel, onDelete }: { titles: string[]; onCancel: () => void; onDelete: () => void }): JSX.Element {
  const [busy, setBusy] = useState(false)
  const heading = titles.length === 1 ? 'Delete this task?' : `Delete ${titles.length} tasks?`
  return <div className="sheet-backdrop todo-ask" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) onCancel() }}
    onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onCancel() } }}>
    <div className="sheet" role="alertdialog" aria-modal="true" aria-label={heading}>
      <h2>{heading}</h2>
      <ul className="todo-ask-list">
        {titles.slice(0, 5).map((title, i) => <li key={i}>{title}</li>)}
        {titles.length > 5 && <li className="more">and {titles.length - 5} more</li>}
      </ul>
      <div className="recovery-actions">
        <button className="btn" onClick={onCancel}>Cancel</button>
        <button className="btn danger" autoFocus disabled={busy} onClick={() => { setBusy(true); onDelete() }}>Delete</button>
      </div>
    </div>
  </div>
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
