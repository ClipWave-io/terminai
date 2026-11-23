import { useCallback, useEffect, useState, type JSX } from 'react'

/**
 * Settings › ManyMotions: connect TerminAI to a school or university on ManyMotions for Education so the
 * student's Claude Code and Codex sessions join their provenance record (main/edu.ts sends them).
 * Two steps: check the code (shows what the institution receives), then choose folders and agree.
 */
type Status = Awaited<ReturnType<typeof window.term.edu.status>>
const when = (iso: string | null) => iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'not yet'
const toolName = (t: string) => t === 'codex' ? 'Codex' : 'Claude Code'

export function EduPanel(): JSX.Element {
  const [st, setSt] = useState<Status | null>(null)
  const [code, setCode] = useState('')
  const [base, setBase] = useState('')
  const [check, setCheck] = useState<{ institution: string; member: string; detail: string; collects: string } | null>(null)
  const [folders, setFolders] = useState<string[]>([])
  const [agree, setAgree] = useState(false)
  const [preview, setPreview] = useState<any[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const load = useCallback(() => window.term.edu.status().then(setSt), [])
  useEffect(() => { void load() }, [load])
  const run = async (f: () => Promise<unknown>) => { setBusy(true); setErr(''); try { await f() } catch (e: any) { setErr(String(e?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')) } finally { setBusy(false) } }
  const addFolder = (list: string[], set: (v: string[]) => void) => run(async () => { const f = await window.term.edu.pickFolder(); if (f && !list.includes(f)) set([...list, f]) })

  if (!st) return <div className="st-card"><span className="hint">Loading…</span></div>

  if (!st.connected) return <div className="st-card">
    <div className="st-card-head"><strong>Connect to your school or university</strong><span>If your course uses ManyMotions, your Claude Code and Codex sessions can count as part of your work: get a connection code on manymotions.org › Settings › Coding sessions and paste it here.</span></div>
    <div className="st-row"><div className="st-label"><strong>Connection code</strong><small>Starts with mm_tai_. It works like a password.</small></div>
      <span className="st-inline"><input type="password" style={{ width: 260 }} spellCheck={false} placeholder="mm_tai_…" value={code} onChange={e => { setCode(e.target.value); setCheck(null) }} />
        <button className="btn" disabled={busy || !code.trim()} onClick={() => run(async () => setCheck(await window.term.edu.check(code.trim(), base || undefined)))}>Check</button></span></div>
    <details><summary className="hint">Server</summary><div className="st-row"><div className="st-label"><strong>Address</strong><small>Leave empty for https://manymotions.org</small></div>
      <span className="st-inline"><input type="text" spellCheck={false} placeholder="https://manymotions.org" value={base} onChange={e => setBase(e.target.value)} /></span></div></details>
    {check && <>
      <div className="st-row"><div className="st-label"><strong>{check.institution}</strong><small>Signed in as {check.member}</small></div></div>
      {check.detail === 'off' ? <p className="hint">{check.institution} does not accept coding sessions yet.</p> : <>
        <div className="st-row"><div className="st-label"><strong>What {check.institution} receives</strong><small>{check.collects}. Only from the folders you choose, only sessions from now on, sent when a session has been quiet for 10 minutes, or when you click Send now.</small></div></div>
        <div className="st-row"><div className="st-label"><strong>Folders that count</strong><small>For example your course or assignment folder. Everything else stays on this Mac.</small></div>
          <span className="st-inline"><button className="btn" disabled={busy} onClick={() => addFolder(folders, setFolders)}>Add folder…</button></span></div>
        {folders.map(f => <div key={f} className="st-row"><code>{f}</code><button className="todo-link" onClick={() => setFolders(folders.filter(x => x !== f))}>Remove</button></div>)}
        <label className="st-row" style={{ justifyContent: 'flex-start', gap: 8 }}><input type="checkbox" checked={agree} onChange={e => setAgree(e.target.checked)} /><span>I agree that TerminAI sends this to {check.institution}.</span></label>
        <div className="st-row"><span /><button className="btn" disabled={busy || !agree || !folders.length} onClick={() => run(async () => { setSt(await window.term.edu.connect({ code: code.trim(), base: base || undefined, folders })); setCode(''); setCheck(null) })}>Connect</button></div>
      </>}
    </>}
    {err && <p className="hint" role="alert" style={{ color: 'var(--danger, #c0392b)' }}>{err}</p>}
  </div>

  return <>
    <div className="st-card">
      <div className="st-card-head"><strong>Connected to {st.institution}</strong><span>As {st.member}. {st.collects}. Sessions since {when(st.since)} from the folders below go to your provenance record.</span></div>
      <div className="st-row"><div className="st-label"><strong>Folders that count</strong></div><span className="st-inline"><button className="btn" disabled={busy} onClick={() => addFolder(st.folders, f => run(async () => setSt(await window.term.edu.folders(f))))}>Add folder…</button></span></div>
      {st.folders.map(f => <div key={f} className="st-row"><code>{f}</code><button className="todo-link" disabled={busy || st.folders.length === 1} onClick={() => run(async () => setSt(await window.term.edu.folders(st.folders.filter(x => x !== f))))}>Remove</button></div>)}
      <div className="st-row"><div className="st-label"><strong>Last sent</strong><small>{st.lastError ? st.lastError : when(st.lastSyncAt)}</small></div>
        <span className="st-inline">
          <button className="btn" disabled={busy} onClick={() => run(async () => setPreview(await window.term.edu.preview()))}>See what is sent next</button>
          <button className="btn" disabled={busy} onClick={() => run(async () => { setSt(await window.term.edu.sync()); setPreview(null) })}>Send now</button>
          <button className="btn" disabled={busy} onClick={() => run(async () => { setSt(await window.term.edu.disconnect()); setPreview(null) })}>Disconnect</button></span></div>
      {err && <p className="hint" role="alert" style={{ color: 'var(--danger, #c0392b)' }}>{err}</p>}
    </div>
    {preview && <div className="st-card"><div className="st-card-head"><strong>Next to be sent</strong><span>Exactly what leaves this Mac. Sent by themselves once a session has been quiet for 10 minutes, or now with Send now.</span></div>
      {!preview.length ? <p className="hint">Nothing waiting.</p> : preview.map((s, i) => <details key={i} className="st-row"><summary>{toolName(s.tool)} · {s.title} · {s.project} · {s.activeMinutes} min · {s.prompts} {s.prompts === 1 ? 'prompt' : 'prompts'}</summary>
        <pre style={{ whiteSpace: 'pre-wrap', fontSize: 11, maxHeight: 240, overflow: 'auto' }}>{JSON.stringify(s, null, 2)}</pre></details>)}</div>}
    {st.history.length > 0 && <div className="st-card"><div className="st-card-head"><strong>Sent</strong><span>The last uploads to {st.institution}.</span></div>
      {st.history.map((h, i) => <div key={i} className="st-row"><div className="st-label"><strong>{when(h.at)}</strong><small>{h.sessions.map(s => `${toolName(s.tool)}: ${s.title} (${s.project}, ${s.minutes} min)`).join(' · ')}</small></div></div>)}</div>}
  </>
}
