import { useEffect, useState, type JSX } from 'react'

/**
 * Import from Chrome into TerminAI Browser (Settings › General and the onboarding): Chrome's logins, saved passwords and
 * bookmarks. macOS keeps other apps' data private, so the first time it needs Full Disk Access for TerminAI: then the
 * message says so plainly, with a button to the right page of System Settings, and Import works once it is on.
 */
export function ChromeImport({ big = false }: { big?: boolean }): JSX.Element {
  const [state, setState] = useState<'' | 'busy' | 'fda' | string>('')
  const [profiles, setProfiles] = useState<{ dir: string; name: string }[]>([]), [from, setFrom] = useState('')
  const load = () => void window.term.browser.chromeProfiles().then(p => { setProfiles(p); if (p[0] && !from) setFrom(p[0].dir) }).catch(() => {})
  useEffect(load, [])
  const go = () => {
    setState('busy')
    void window.term.browser.importChrome(from || undefined)
      .then(r => setState(`Imported from ${r.profile}: ${r.cookies.toLocaleString()} logins, ${r.passwords.toLocaleString()} passwords${r.bookmarks ? ', bookmarks' : ''}.`))
      .catch(e => { const m = String(e?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''); setState(/NEEDS_FULL_DISK_ACCESS|EPERM|EACCES/.test(m) ? 'fda' : `Could not import: ${m}`) })
  }
  return <span className={`chrome-import${big ? ' big' : ''}`}>
    {state === 'fda' && <small className="hint chrome-import-msg">macOS keeps Chrome's data private. Turn on <b>TerminAI</b> in Privacy &amp; Security › Full Disk Access, then click Import again.
      <button className="todo-link" onClick={() => void window.term.browser.openFullDiskAccess()}>Open Full Disk Access</button></small>}
    {state && state !== 'busy' && state !== 'fda' && <small className="hint chrome-import-msg">{state}</small>}
    <span className="chrome-import-row">
      {profiles.length > 1 && <select value={from} onChange={e => setFrom(e.target.value)} aria-label="Chrome profile">{profiles.map(p => <option key={p.dir} value={p.dir}>{p.name}</option>)}</select>}
      <button className={big ? 'onb-primary' : 'btn'} disabled={state === 'busy'} onClick={() => { if (state === 'fda') load(); go() }}>{state === 'busy' ? 'Importing…' : 'Import from Chrome'}</button>
    </span>
  </span>
}
