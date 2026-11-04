import { useEffect, useState } from 'react'
import type { JSX } from 'react'
import type { TasksUser, WorkDay } from '../../shared/types'

/**
 * The work log (src/main/worklog.ts): one day, yours or the partner's. Working time, hours by project, and every
 * conversation with each finished step at the time it was announced. Your own day is read on this Mac, always
 * current; the partner's is what their TerminAI last sent (every 10 minutes).
 */
const NAME: Record<string, string> = { ilai: 'Ilai', livio: 'Matteo' }
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const hm = (m: number) => m >= 60 ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}` : `${m} min`
const clock = (at: string) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })

export function WorkLog({ user }: { user: TasksUser }): JSX.Element {
  const [day, setDay] = useState(iso(new Date()))
  const [who, setWho] = useState<string>(user)
  const [data, setData] = useState<{ people: Record<string, WorkDay>; offline: boolean } | null>(null)
  const [error, setError] = useState('')
  const [open, setOpen] = useState<number | null>(null)
  useEffect(() => {
    let live = true
    const load = () => window.term.worklog.get(day).then(v => { if (live) { setData(v); setError('') } }).catch(e => live && setError(String(e?.message ?? e)))
    setData(null); setOpen(null); void load()
    const t = window.setInterval(load, 60_000)
    return () => { live = false; window.clearInterval(t) }
  }, [day])
  const step = (n: number) => { const d = new Date(`${day}T12:00:00`); d.setDate(d.getDate() + n); setDay(iso(d)) }
  const isToday = day === iso(new Date())
  const log = data?.people[who]
  const max = Math.max(1, ...(log?.projects.map(p => p.minutes) ?? [1]))
  return <div className="wlog">
    <div className="wlog-bar">
      <button className="todo-icon" aria-label="Previous day" onClick={() => step(-1)}>‹</button>
      <strong>{new Date(`${day}T12:00:00`).toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' })}</strong>
      <button className="todo-icon" aria-label="Next day" disabled={isToday} onClick={() => step(1)}>›</button>
      {!isToday && <button className="todo-link" onClick={() => setDay(iso(new Date()))}>Today</button>}
      <span className="todo-head-gap" />
      <span className="todo-seg" role="tablist" aria-label="Whose day">
        {(['ilai', 'livio'] as const).map(p => <button key={p} role="tab" aria-selected={who === p} className={who === p ? 'on' : ''} onClick={() => setWho(p)}>
          {NAME[p]}{data?.people[p] ? ` · ${hm(data.people[p].workingMinutes)}` : ''}</button>)}
      </span>
    </div>
    {error && <p className="todo-error">{error}</p>}
    {!data ? <p className="wlog-empty">Reading the log…</p> : !log ? <p className="wlog-empty">
      {who === user ? 'No conversations this day.' : `Nothing from ${NAME[who]} for this day${data.offline ? ' (not signed in to Sync)' : ''}. Their TerminAI sends the log every 10 minutes once they run 0.3.6 or later.`}</p> : <div className="wlog-body">
      <section className="wlog-side">
        <div className="wlog-total"><b>{hm(log.workingMinutes)}</b><span>working time · {log.conversations.length} conversations</span></div>
        <h4>Hours by project</h4>
        {log.projects.map(p => <div key={p.place} className="wlog-proj" title={p.place}>
          <span>{p.place.split('/').pop()}</span><i style={{ width: `${(p.minutes / max) * 100}%` }} /><em>{hm(p.minutes)}</em></div>)}
        <small>The total counts conversations running at the same time once; per project they add up. Pauses over 5 minutes are not counted.</small>
      </section>
      <ol className="wlog-list">
        {log.conversations.map((c, i) => <li key={i} className={open === i ? 'open' : ''}>
          <button className="wlog-conv" onClick={() => setOpen(open === i ? null : i)}>
            <span className="wlog-time">{clock(c.start)}–{clock(c.end)}</span>
            <strong>{c.title}</strong>
            <span className="wlog-meta">{c.tool} · {c.place.split('/').pop()} · {hm(c.activeMinutes)} · {c.done.length} done</span>
          </button>
          {(open === i ? c.done : c.done.slice(-1)).map((d, j) => <p key={j} className="wlog-done"><time>{clock(d.at)}</time>{d.text}</p>)}
        </li>)}
      </ol>
    </div>}
  </div>
}
