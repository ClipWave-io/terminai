import { useEffect, useRef, useState, type JSX } from 'react'
import type { BrowserState } from '../../shared/browser'

export function BrowserPane({ visible, layoutKey, onClose }: { visible: boolean; layoutKey: string; onClose: () => void }): JSX.Element {
  const host = useRef<HTMLDivElement>(null)
  const [address, setAddress] = useState('https://www.google.com')
  const [state, setState] = useState<BrowserState>({ url: '', title: '', loading: false, canGoBack: false, canGoForward: false, error: '' })
  const [error, setError] = useState('')
  const run = (action: Promise<unknown>) => { setError(''); void action.catch(e => setError(String(e))) }
  useEffect(() => {
    const update = (next: BrowserState) => { setState(next); if (next.url) setAddress(next.url) }
    void window.term.browser.state().then(update)
    return window.term.browser.onState(update)
  }, [])
  useEffect(() => {
    const element = host.current
    if (!element) return
    const layout = () => {
      const { x, y, width, height } = element.getBoundingClientRect()
      void window.term.browser.layout({ x, y, width, height, visible })
    }
    const observer = new ResizeObserver(layout)
    observer.observe(element)
    window.addEventListener('resize', layout)
    layout()
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', layout)
      void window.term.browser.layout({ x: 0, y: 0, width: 0, height: 0, visible: false })
    }
  }, [visible, layoutKey])
  return <aside className="browser-pane" aria-label="Browser">
    <div className="browser-heading"><strong>Browser</strong><span>Chromium · separate session</span><button className="btn" onClick={onClose} aria-label="Close browser">×</button></div>
    <form className="browser-toolbar" onSubmit={event => { event.preventDefault(); run(window.term.browser.navigate(address)) }}>
      <button className="btn" type="button" aria-label="Back" disabled={!state.canGoBack} onClick={() => run(window.term.browser.command('back'))}>←</button>
      <button className="btn" type="button" aria-label="Forward" disabled={!state.canGoForward} onClick={() => run(window.term.browser.command('forward'))}>→</button>
      <button className="btn" type="button" aria-label="Reload" disabled={!state.url} onClick={() => run(window.term.browser.command('reload'))}>↻</button>
      <input aria-label="Web address" value={address} onChange={event => setAddress(event.target.value)} spellCheck={false} autoCapitalize="off" />
      <button className="btn" type="submit">Go</button>
    </form>
    <div className="browser-status"><span role="status">{error || state.error || (state.loading ? 'Loading…' : state.title || 'Enter a web address to begin')}</span><button className="btn" disabled={!state.url} onClick={() => run(window.term.browser.command('external'))}>Open in Chrome</button></div>
    <div className="browser-viewport" ref={host} />
  </aside>
}
