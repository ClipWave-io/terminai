import { useEffect, useRef, useState, type JSX } from 'react'
import { finders, type FindResult } from '../find'

/**
 * ⌘F: searches inside the conversation in view (its terminal scrollback, or the Clean view's text when that is shown)
 * and, with the same words, filters the conversation titles in the sidebar. Enter: next, ⇧Enter: previous, Esc: close.
 */
export function FindBar({ tabId, query, onQuery, titles, onClose }: { tabId: string; query: string; onQuery: (q: string) => void; titles: number; onClose: () => void }): JSX.Element {
  const field = useRef<HTMLInputElement>(null)
  const [result, setResult] = useState<FindResult>({ index: -1, count: 0 })
  const finder = () => finders.get(`clean:${tabId}`) ?? finders.get(tabId)
  const run = (back: boolean, incremental: boolean) => { const f = finder(); if (!f) return; void f.find(query, back, incremental).then(setResult) }
  useEffect(() => { field.current?.focus(); field.current?.select() }, [])
  useEffect(() => { run(false, true) }, [query, tabId])
  useEffect(() => () => { finders.get(`clean:${tabId}`)?.clear(); finders.get(tabId)?.clear() }, [tabId])
  const here = !query ? '' : result.count ? `${result.index + 1} of ${result.count}` : 'Not here'
  return <div className="find-bar" role="search">
    <input ref={field} className="find-input" value={query} placeholder="Find in this conversation and titles" aria-label="Find"
      onChange={e => onQuery(e.target.value)}
      onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); run(e.shiftKey, false) } else if (e.key === 'Escape') { e.preventDefault(); onClose() } }} />
    <span className="find-count" title="Matches in this conversation; the sidebar shows the conversations whose titles match">{here}{query ? ` · ${titles} title${titles === 1 ? '' : 's'}` : ''}</span>
    <button type="button" aria-label="Previous match" title="Previous  ⇧↩" onClick={() => run(true, false)}>↑</button>
    <button type="button" aria-label="Next match" title="Next  ↩" onClick={() => run(false, false)}>↓</button>
    <button type="button" aria-label="Close find" title="Close  Esc" onClick={onClose}>×</button>
  </div>
}
