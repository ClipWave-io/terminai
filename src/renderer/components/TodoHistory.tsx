import { useEffect, useState } from 'react'
import type { JSX } from 'react'
import type { Task, TaskVersion } from '../../shared/types'

const NAME: Record<string, string> = { livio: 'Matteo', ilai: 'Ilai' }
const STATUS: Record<string, string> = { open: 'Open', doing: 'In progress', done: 'Done' }
const WHO: Record<string, string> = { livio: 'Matteo', ilai: 'Ilai', both: 'Together' }

/** "14:32" today, "21 Oct 14:32" before. Europe/Rome like the rest of the app. */
export function when(iso: string): string {
  const zone = { timeZone: 'Europe/Rome' }, d = new Date(iso)
  const time = d.toLocaleTimeString('en-GB', { ...zone, hour: '2-digit', minute: '2-digit' })
  const day = (x: Date) => x.toLocaleDateString('en-GB', zone)
  return day(d) === day(new Date()) ? time : `${d.toLocaleDateString('en-GB', { ...zone, day: 'numeric', month: 'short' })} ${time}`
}

type Line = { kind: 'same' | 'del' | 'add'; text: string }
/** Line by line, longest common subsequence: what a note lost and gained between two versions. */
function lineDiff(before: string, after: string): Line[] {
  const a = before ? before.split('\n') : [], b = after ? after.split('\n') : []
  const n = a.length, m = b.length
  const lcs = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
  const out: Line[] = []
  let i = 0, j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ kind: 'same', text: a[i] }); i++; j++ }
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) out.push({ kind: 'del', text: a[i++] })
    else out.push({ kind: 'add', text: b[j++] })
  }
  while (i < n) out.push({ kind: 'del', text: a[i++] })
  while (j < m) out.push({ kind: 'add', text: b[j++] })
  return out
}

/** One version against the one before it: changed fields as before → after, the note line by line. */
function Change({ before, after }: { before: Task | null; after: Task | null }): JSX.Element {
  if (!after) return <p className="todo-history-what">Deleted{before ? <> · it was “{before.title}”</> : null}</p>
  const fields: [string, string, string][] = [
    ['Task', before?.title ?? '', after.title],
    ['Status', before ? STATUS[before.status] : '', STATUS[after.status]],
    ['Column', before ? WHO[before.assignee ?? ''] ?? 'Unassigned' : '', WHO[after.assignee ?? ''] ?? 'Unassigned'],
    ['Product', before?.product ?? '', after.product],
  ]
  const changed = fields.filter(([, was, is]) => was !== is)
  const notes = (before?.notes ?? '') !== after.notes ? lineDiff(before?.notes ?? '', after.notes) : null
  return <>
    <p className="todo-history-what">{before ? 'Changed' : 'Created'}</p>
    {changed.map(([label, was, is]) => <div key={label} className="todo-history-field">
      <span className="todo-history-label">{label}</span>
      {before && was ? <><del>{was}</del><span aria-hidden="true"> → </span></> : null}<ins>{is || '—'}</ins>
    </div>)}
    {notes && <div className="todo-history-field notes">
      <span className="todo-history-label">Note</span>
      <pre className="todo-history-notes">{notes.map((line, k) => <span key={k} className={line.kind}>{line.kind === 'del' ? '− ' : line.kind === 'add' ? '+ ' : '  '}{line.text || ' '}{'\n'}</span>)}</pre>
    </div>}
    {!changed.length && !notes && <p className="todo-muted">Moved in its list, nothing else changed.</p>}
  </>
}

/** Every version of a shared task from the build-tasks history, each one against the one before. */
export function TodoHistory({ task, onClose }: { task: Task; onClose: () => void }): JSX.Element {
  const [versions, setVersions] = useState<TaskVersion[] | null>(null)
  const [at, setAt] = useState(0)
  const [error, setError] = useState('')
  useEffect(() => { void window.term.todos.history(task.id).then(setVersions, (err: Error) => setError(err.message)) }, [task.id])
  const shown = versions?.[at]
  return <div className="sheet-backdrop" onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); onClose() } }}>
    <div className="sheet todo-history" role="dialog" aria-label={`History of ${task.title}`}>
      <h2>History</h2>
      <p className="todo-history-title">{task.title}</p>
      {error && <p className="todo-error" role="alert">{error}</p>}
      {versions && !versions.length && <p className="todo-muted">No history yet: it has not been synced.</p>}
      {!!versions?.length && <div className="todo-history-body">
        <ol className="todo-history-list" aria-label="Versions, newest first">
          {versions.map((v, i) => <li key={v.hash}>
            <button aria-current={i === at} onClick={() => setAt(i)}>
              <span className="todo-history-who">{NAME[v.by] ?? v.by}</span>
              <span className="todo-history-msg">{v.message.replace(/^\w+: /, '')}</span>
              <span className="todo-history-when">{when(v.at)}</span>
            </button>
          </li>)}
        </ol>
        <div className="todo-history-diff">{shown && <Change before={versions[at + 1]?.task ?? null} after={shown.task} />}</div>
      </div>}
      <div className="recovery-actions"><button className="btn primary" autoFocus onClick={onClose}>Done</button></div>
    </div>
  </div>
}
