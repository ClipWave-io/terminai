import { useEffect, useRef, useState } from 'react'
import type { JSX } from 'react'
import { isMine, type Task, type TaskInput, type TaskList, type TaskScope, type TasksUser } from '../../shared/types'
import './todos.css'

type Draft = { title: string; notes: string; product: string; assignee: Task['assignee'] }
type Save = (scope: TaskScope, input: TaskInput) => Promise<boolean>
const EMPTY: Draft = { title: '', notes: '', product: '', assignee: null }
const STATUS_LABEL = { open: 'Open', doing: 'Doing', done: 'Done' } as const
const STATUS_NEXT = { open: 'doing', doing: 'done', done: 'open' } as const
const RANK = { doing: 0, open: 1, done: 2 }
const ASSIGNEES: [Task['assignee'], string][] = [['livio', 'Livio'], ['ilai', 'Ilai'], ['both', 'Both'], [null, 'Nobody']]
const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
const when = (iso: string | null, seconds = false) => iso ? new Date(iso).toLocaleString('en-GB', { timeZone: 'Europe/Rome', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', ...(seconds ? { second: '2-digit' } : {}) }) : ''

/** Personal to-dos (this Mac only) and shared ones (the build-tasks repo), over the terminals, which stay mounted. */
export function TodoSheet({ user, onUser, onClose }: { user: TasksUser | ''; onUser: (user: TasksUser) => void; onClose: () => void }): JSX.Element {
  const [data, setData] = useState<TaskList | null>(null)
  const [show, setShow] = useState<'open' | 'done'>('open')
  const [mineOnly, setMineOnly] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
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

  async function act(work: () => Promise<TaskList>): Promise<boolean> {
    setBusy(true); setError('')
    try { setData(await work()); return true } catch (err) { setError(errorText(err)); return false } finally { setBusy(false) }
  }
  const save: Save = (scope, input) => act(() => window.term.todos.save(scope, input))
  const remove = (scope: TaskScope, id: string) => act(() => window.term.todos.remove(scope, id))
  const visible = (tasks: Task[]) => tasks
    .filter(task => (show === 'done') === (task.status === 'done') && (!mineOnly || isMine(task, user)))
    .sort((a, b) => RANK[a.status] - RANK[b.status] || Date.parse(b.createdAt) - Date.parse(a.createdAt))
  const sync = data?.sync

  return <div className="workspace-overlay todo-overlay" role="presentation"
    onClick={event => { if (event.target === event.currentTarget) onClose() }}
    onKeyDown={event => { if (event.key === 'Escape' && !event.defaultPrevented) { event.stopPropagation(); onClose() } }}>
    <section ref={sheet} tabIndex={-1} className="todo-sheet" role="dialog" aria-modal="true" aria-labelledby="todo-title">
      <header>
        <div><h2 id="todo-title">To-do</h2><p>Personal tasks stay on this Mac. Shared tasks sync between Livio and Ilai through the build-tasks repo.</p></div>
        <div className="todo-who" role="group" aria-label="You are"><span>You are</span>
          {(['livio', 'ilai'] as const).map(name => <button key={name} className={`btn ${user === name ? 'primary' : ''}`} aria-pressed={user === name} onClick={() => onUser(name)}>{name === 'livio' ? 'Livio' : 'Ilai'}</button>)}
        </div>
        <button className="btn" onClick={onClose} aria-label="Close to-do">Close</button>
      </header>
      {!user ? <p className="todo-pick">Choose who you are on this Mac to start. It is saved here and signs every change you make.</p> : <>
        <div className="todo-bar">
          <div className="todo-segment" role="group" aria-label="Show">
            <button aria-pressed={show === 'open'} onClick={() => setShow('open')}>Open</button>
            <button aria-pressed={show === 'done'} onClick={() => setShow('done')}>Done</button>
          </div>
          <div className="todo-segment" role="group" aria-label="Whose">
            <button aria-pressed={mineOnly} onClick={() => setMineOnly(true)}>Mine</button>
            <button aria-pressed={!mineOnly} onClick={() => setMineOnly(false)}>Everyone</button>
          </div>
          <span className="todo-sync" aria-live="polite">{!sync ? '' : !sync.enabled ? 'Shared sync is off' : sync.syncing ? 'Syncing…' : sync.lastSync ? `Synced ${when(sync.lastSync, true)}` : 'Not synced yet'}</span>
          <button className="btn" disabled={busy || !sync?.enabled || sync.syncing} onClick={() => void act(() => window.term.todos.sync())}>Sync now</button>
        </div>
        {error && <p className="todo-error" role="alert">{error}</p>}
        {sync?.error && <p className="todo-error todo-sync-error" role="alert">Shared sync: {sync.error}</p>}
        <div className="todo-columns">
          {(['personal', 'shared'] as const).map(scope => {
            const tasks = visible(data?.[scope] ?? [])
            return <section key={scope} className="todo-column" data-scope={scope} aria-label={scope === 'personal' ? 'Personal' : 'Shared'}>
              <h3>{scope === 'personal' ? 'Personal' : 'Shared'} <small>{tasks.length}</small></h3>
              <TaskForm initial={EMPTY} label="Add" busy={busy} onSubmit={draft => save(scope, draft)} />
              <ul className="todo-list">{tasks.map(task => <TaskRow key={task.id} task={task} scope={scope} busy={busy} onSave={save} onRemove={remove} />)}</ul>
              {!tasks.length && <p className="todo-muted">{show === 'open' ? 'Nothing open.' : 'Nothing done yet.'}</p>}
            </section>
          })}
        </div>
      </>}
    </section>
  </div>
}

function Assignee({ value, disabled, onChange }: { value: Task['assignee']; disabled?: boolean; onChange: (value: Task['assignee']) => void }): JSX.Element {
  return <div className="todo-assign" role="group" aria-label="Assignee">
    {ASSIGNEES.map(([key, label]) => <button type="button" key={label} className="todo-chip" aria-pressed={value === key} disabled={disabled} onClick={() => onChange(key)}>{label}</button>)}
  </div>
}

function TaskForm({ initial, label, busy, onSubmit, onCancel }: { initial: Draft; label: string; busy: boolean; onSubmit: (draft: Draft) => Promise<boolean>; onCancel?: () => void }): JSX.Element {
  const [draft, setDraft] = useState(initial)
  const set = (patch: Partial<Draft>) => setDraft(value => ({ ...value, ...patch }))
  return <form className="todo-form"
    onSubmit={async event => { event.preventDefault(); if (await onSubmit(draft) && !onCancel) setDraft(initial) }}
    onKeyDown={event => { if (event.key === 'Escape' && onCancel) { event.preventDefault(); event.stopPropagation(); onCancel() } }}>
    <input aria-label="Title" placeholder={onCancel ? 'Title' : 'New task'} value={draft.title} maxLength={300} autoFocus={!!onCancel} onChange={event => set({ title: event.target.value })} />
    <div className="todo-form-row">
      <input aria-label="Product" placeholder="Product" value={draft.product} maxLength={100} onChange={event => set({ product: event.target.value })} />
      <Assignee value={draft.assignee} onChange={assignee => set({ assignee })} />
    </div>
    <textarea aria-label="Notes" placeholder="Notes" rows={2} value={draft.notes} maxLength={20000} onChange={event => set({ notes: event.target.value })} />
    <div className="todo-form-actions">
      {onCancel && <button type="button" className="btn" onClick={onCancel}>Cancel</button>}
      <button className="btn primary" disabled={busy || !draft.title.trim()}>{label}</button>
    </div>
  </form>
}

function TaskRow({ task, scope, busy, onSave, onRemove }: { task: Task; scope: TaskScope; busy: boolean; onSave: Save; onRemove: (scope: TaskScope, id: string) => Promise<boolean> }): JSX.Element {
  const [editing, setEditing] = useState(false)
  const [confirming, setConfirming] = useState(false)
  if (editing) return <li className="todo-task editing" data-id={task.id}>
    <TaskForm initial={{ title: task.title, notes: task.notes, product: task.product, assignee: task.assignee }} label="Save" busy={busy}
      onCancel={() => setEditing(false)}
      onSubmit={async draft => { const ok = await onSave(scope, { id: task.id, ...draft }); if (ok) setEditing(false); return ok }} />
  </li>
  const next = STATUS_NEXT[task.status]
  return <li className={`todo-task ${task.status}`} data-id={task.id}>
    <button className={`todo-status ${task.status}`} disabled={busy} aria-label={`Status ${STATUS_LABEL[task.status]}, mark ${STATUS_LABEL[next]}`} title={`Mark ${STATUS_LABEL[next]}`}
      onClick={() => void onSave(scope, { id: task.id, status: next })}>{STATUS_LABEL[task.status]}</button>
    <div className="todo-main">
      <div className="todo-title">{task.title}{task.product && <span className="todo-product">{task.product}</span>}</div>
      {task.notes && <p className="todo-notes">{task.notes}</p>}
      <div className="todo-meta">
        <Assignee value={task.assignee} disabled={busy} onChange={assignee => void onSave(scope, { id: task.id, assignee })} />
        <span title={`Created by ${task.createdBy} ${when(task.createdAt)}`}>{task.updatedBy} · {when(task.updatedAt)}</span>
        {confirming
          ? <span className="todo-confirm" role="group" aria-label="Confirm delete">Delete this task?
              <button className="btn" disabled={busy} onClick={() => void onRemove(scope, task.id)}>Delete</button>
              <button className="btn" autoFocus onClick={() => setConfirming(false)}>Cancel</button>
            </span>
          : <><button className="todo-link" onClick={() => setEditing(true)}>Edit</button><button className="todo-link" onClick={() => setConfirming(true)}>Delete</button></>}
      </div>
    </div>
  </li>
}
