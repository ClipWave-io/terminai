import { Component, type ReactNode } from 'react'

/**
 * A part of the window that fails to draw (a bug in one sheet) shows what happened and a way out, instead of taking the
 * whole window down to a blank screen (13/11: opening Notes blanked TerminAI until a restart).
 */
export class Boundary extends Component<{ name: string; children: ReactNode; onClose?: () => void }, { error: Error | null }> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) { return { error } }
  componentDidCatch(error: Error) { console.error(`[${this.props.name}]`, error) }
  render() {
    if (!this.state.error) return this.props.children
    return <div className="boundary" role="alert">
      <strong>{this.props.name} hit a problem</strong>
      <small>{String(this.state.error.message || this.state.error).slice(0, 300)}</small>
      <span>
        <button className="btn" onClick={() => this.setState({ error: null })}>Try again</button>
        {this.props.onClose && <button className="btn" onClick={() => { this.setState({ error: null }); this.props.onClose!() }}>Close</button>}
        <button className="btn" onClick={() => location.reload()}>Reload window</button>
      </span>
    </div>
  }
}
