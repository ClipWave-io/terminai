import * as ptys from './pty'
import type { CloudSession } from '../shared/types'

/**
 * Cloud sessions: `claude --cloud "<task>"` in any tab prints "Created cloud session: <title>" and "View: <url>" and returns.
 * This watches the tabs' output for those lines and tells the window, which marks the tab ☁ and keeps the session's link.
 */
const seen = new Map<string, string>() // tab id -> cloud session id already reported
const strip = (s: string) => s.replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '').replace(/\r/g, '')
export function cloudOf(text: string): CloudSession | null {
  const t = strip(text), views = [...t.matchAll(/View: (https:\/\/claude\.ai\/code\/(session_[A-Za-z0-9]+)\S*)/g)]
  const last = views.at(-1); if (!last) return null
  const title = [...t.slice(0, last.index).matchAll(/Created cloud session: (.+)/g)].at(-1)?.[1]?.trim()
  return { id: last[2], url: `https://claude.ai/code/${last[2]}`, ...(title ? { title: title.slice(0, 120) } : {}) }
}
export function watchCloud(found: (tabId: string, cloud: CloudSession) => void): void {
  setInterval(() => {
    for (const id of ptys.liveIds()) {
      let buf = ''; try { buf = ptys.bufferOf(id) } catch { continue }
      if (!buf.includes('claude.ai/code/session_')) continue
      const c = cloudOf(buf.slice(-8000)); if (!c || seen.get(id) === c.id) continue
      seen.set(id, c.id); found(id, c)
    }
  }, 3000)
}
