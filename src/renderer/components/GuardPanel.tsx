import { useEffect, useState } from 'react'
import type { JSX } from 'react'

type Details = NonNullable<Awaited<ReturnType<typeof window.term.macguard.details>>>
const LEVELS = ['OK', 'Warning', 'Critical']
const CLASS = ['normal', 'warning', 'critical']

/**
 * Settings › MacGuard: this Mac's memory guardian at a glance. What it measures against its limits, the chats it paused
 * (Resume here or open them), whether a new session may start now (the same check as `macguard gate`), and what it did.
 */
export function GuardPanel({ tabs, onOpenTab }: { tabs: { id: string; label: string }[]; onOpenTab: (id: string) => void }): JSX.Element {
  const [d, setD] = useState<Details | null | undefined>(undefined)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const load = () => void window.term.macguard.details().then(setD).catch(() => setD(null))
  useEffect(() => { load(); const t = window.setInterval(load, 3000); return () => window.clearInterval(t) }, [])
  const act = (what: string, run: () => Promise<unknown>) => {
    setBusy(what); setError('')
    void run().then(load).catch(e => setError(String(e?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '').split('\n')[0])).finally(() => setBusy(''))
  }
  if (d === undefined) return <></>
  if (d === null) return <section className="mem"><p className="hint">MacGuard is not installed on this Mac (no state in ~/Library/Application Support/MacGuard).</p></section>
  const s = d.sample, l = d.limits, name = (id: string, fallback: string) => tabs.find(t => t.id === id)?.label || fallback
  // [label, value, limits in words, 0 ok · 1 warning · 2 critical]
  const rows: [string, string, string, number][] = [
    ['Free memory', `${s.mem_level ?? '?'}%`, `warning below ${l.memlevel_warn}%, critical below ${l.memlevel_crit}%`, s.mem_level < l.memlevel_crit ? 2 : s.mem_level < l.memlevel_warn ? 1 : 0],
    ['Compressed memory', `${(s.compressor_gb ?? 0).toFixed(1)} GB`, `warning above ${l.compressor_warn_gb} GB, critical above ${l.compressor_crit_gb} GB`, s.compressor_gb > l.compressor_crit_gb ? 2 : s.compressor_gb > l.compressor_warn_gb ? 1 : 0],
    ['Swap on disk', `${(s.swap_used_gb ?? 0).toFixed(1)} GB`, `warning above ${l.swap_warn_gb} GB`, s.swap_used_gb > l.swap_warn_gb ? 1 : 0],
    ['Free disk', `${(s.disk_free_gb ?? 0).toFixed(1)} GB`, `warning below ${l.disk_warn_gb} GB, critical below ${l.disk_crit_gb} GB`, s.disk_free_gb < l.disk_crit_gb ? 2 : s.disk_free_gb < l.disk_warn_gb ? 1 : 0],
    ['macOS memory pressure', s.pressure >= 4 ? 'Critical' : s.pressure >= 2 ? 'Warning' : 'Normal', 'as the kernel reports it', s.pressure >= 4 ? 2 : s.pressure >= 2 ? 1 : 0],
    ['CPU load', `${(s.load1 ?? 0).toFixed(1)} on ${s.ncpu ?? '?'} cores`, `warning above ${l.load_warn_per_cpu} per core for 30 s`, s.load1 > l.load_warn_per_cpu * (s.ncpu || 8) ? 1 : 0],
    ['GPU', `${s.gpu_pct ?? '?'}%`, `warning above ${l.gpu_warn_pct}% for a minute`, s.gpu_pct > l.gpu_warn_pct ? 1 : 0],
  ]
  // The same check as `macguard gate 1`: one more session now?
  const gate = [
    d.sessions + 1 > l.gate_max_sessions && `${d.sessions} sessions open, the limit is ${l.gate_max_sessions}`,
    s.disk_free_gb < l.gate_disk_gb && `free disk below ${l.gate_disk_gb} GB`,
    s.mem_level < l.gate_memlevel && `free memory below ${l.gate_memlevel}%`,
    s.compressor_gb > l.gate_compressor_gb && `compressed memory above ${l.gate_compressor_gb} GB`,
  ].filter((x): x is string => !!x)
  return <>
    <section className="mem guard-panel">
      <div className="mem-head"><strong>Status</strong>
        <span className={`mem-level ${d.running ? CLASS[d.level] : 'stopped'}`}>{d.running ? LEVELS[d.level] : 'Not running'}</span></div>
      <p className="hint">{d.running ? `Measured every few seconds; last at ${d.at}. ` : 'MacGuard has not written its state for a while, so nothing is watching the Mac right now. '}
        At Critical it pauses the heaviest chat you are not looking at, one more only if the Mac keeps getting worse, never more than three, and resumes them one by one once it is back to normal.</p>
      <div className="guard-rows">{rows.map(([label, value, limit, lv]) => <div key={label} className="guard-row">
        <span className={`guard-dot l${lv}`} aria-hidden="true" /><span>{label}</span><b>{value}</b><em>{limit}</em></div>)}</div>
    </section>
    <section className="mem guard-panel">
      <div className="mem-head"><strong>Paused chats</strong>{d.paused.length > 1 && <button className="btn" disabled={!!busy} onClick={() => act('all', () => window.term.macguard.resume([]))}>{busy === 'all' ? 'Resuming…' : `Resume all (${d.paused.length})`}</button>}</div>
      {d.paused.length === 0 ? <p className="hint">None.</p> : d.paused.map(p => <div key={p.id} className="guard-paused">
        <span className="guard-icon" aria-hidden="true" /><span>{name(p.id, p.name)}<em> · paused at {p.at.slice(0, 5)}</em></span>
        <button className="btn" onClick={() => onOpenTab(p.id)}>Open</button>
        <button className="btn primary" disabled={!!busy} onClick={() => act(p.id, () => window.term.macguard.resume([p.id]))}>{busy === p.id ? 'Resuming…' : 'Resume'}</button></div>)}
      {error && <p className="hint guard-error">Could not do it: {error}</p>}
      <p className="hint">A chat you resume here is not paused again for {Math.round(l.resume_hold_s / 60)} minutes.</p>
    </section>
    <section className="mem guard-panel">
      <div className="mem-head"><strong>New sessions</strong><span className={`mem-level ${gate.length ? 'warning' : 'normal'}`}>{gate.length ? 'Better not' : 'OK to open'}</span></div>
      <p className="hint">{d.sessions} chats running. {gate.length ? `Opening another now: ${gate.join('; ')}.` : 'Another one can start now.'}</p>
    </section>
    <section className="mem guard-panel">
      <div className="mem-head"><strong>What it did</strong><button className="btn" disabled={!!busy} onClick={() => act('restart', () => window.term.macguard.restart())}>{busy === 'restart' ? 'Restarting…' : 'Restart MacGuard'}</button></div>
      {d.events.length === 0 ? <p className="hint">Nothing today or yesterday.</p> : <div className="guard-events">{d.events.map((e, i) => <div key={i}><em>{e.at}</em><span>{e.text}</span></div>)}</div>}
    </section>
  </>
}
