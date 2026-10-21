import { useEffect, useRef, useState } from 'react'
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

const fields = (task: Task): [string, string][] => [
  ['Task', task.title],
  ['Status', STATUS[task.status]],
  ['Column', WHO[task.assignee ?? ''] ?? 'Unassigned'],
  ['Product', task.product || '—'],
]

/** One version next to the one before it: BEFORE and AFTER side by side, what changed highlighted. */
function Change({ before, after, beforeBy, afterBy }: { before: TaskVersion | null; after: TaskVersion; beforeBy: string; afterBy: string }): JSX.Element {
  const was = before?.task ?? null, is = after.task
  const lines = lineDiff(was?.notes ?? '', is?.notes ?? '')
  const side = (task: Task | null, keep: 'del' | 'add', other: Task | null, empty: string) => <div className="todo-history-side">
    {task ? <>
      {fields(task).map(([label, value], k) => <div key={label} className={`todo-history-field${other && fields(other)[k][1] !== value ? ` ${keep}` : ''}`}>
        <span className="todo-history-label">{label}</span><span className="todo-history-value">{value}</span>
      </div>)}
      <div className="todo-history-field notes">
        <span className="todo-history-label">Note</span>
        {lines.some(line => line.kind !== (keep === 'del' ? 'add' : 'del'))
          ? <pre className="todo-history-notes">{lines.filter(line => line.kind === 'same' || line.kind === keep).map((line, k) => <span key={k} className={line.kind === 'same' || !other ? 'same' : keep}>{line.text || ' '}{'\n'}</span>)}</pre>
          : <span className="todo-muted">No note</span>}
      </div>
    </> : <p className="todo-muted">{empty}</p>}
  </div>
  return <div className="todo-history-compare">
    <h4>Before{before && <span> · {beforeBy}, {when(before.at)}</span>}</h4>
    <h4>After<span> · {afterBy}, {when(after.at)}</span></h4>
    {side(was, 'del', is, before ? 'Deleted at this point.' : `Did not exist yet: ${afterBy} created it here.`)}
    {side(is, 'add', was, 'Deleted here.')}
  </div>
}

/** Every version of a shared task from the build-tasks history, each one against the one before. */
export function TodoHistory({ task, onClose }: { task: Task; onClose: () => void }): JSX.Element {
  const [versions, setVersions] = useState<TaskVersion[] | null>(null)
  const [at, setAt] = useState(0)
  const [error, setError] = useState('')
  useEffect(() => { void window.term.todos.history(task.id).then(setVersions, (err: Error) => setError(err.message)) }, [task.id])
  const diff = useRef<HTMLDivElement>(null)
  // A change at the end of a long note would sit out of sight: bring the first one into view.
  useEffect(() => {
    const box = diff.current, first = box?.querySelector<HTMLElement>('.add, .del')
    if (!box || !first) return
    box.scrollTop = Math.max(0, first.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop - 40)
  }, [versions, at])
  const shown = versions?.[at]
  return <div className="sheet-backdrop" onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); onClose() } }}>
    <div className="sheet todo-history" role="dialog" aria-label={`History of ${task.title}`}>
      <h2>History</h2>
      <p className="todo-history-title">{task.title}</p>
      <p className="todo-muted todo-history-hint">Pick a version on the left: it shows next to the one before it.</p>
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
        <div ref={diff} className="todo-history-diff">{shown && <Change before={versions[at + 1] ?? null} after={shown} beforeBy={NAME[versions[at + 1]?.by] ?? versions[at + 1]?.by ?? ''} afterBy={NAME[shown.by] ?? shown.by} />}</div>
      </div>}
      <div className="recovery-actions"><button className="btn primary" autoFocus onClick={onClose}>Done</button></div>
    </div>
  </div>
}
