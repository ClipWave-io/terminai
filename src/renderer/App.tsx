import { PaneResizeHandle } from './components/PaneResizeHandle'
import { useCallback, useEffect, useRef, useState } from 'react'
import { ProjectFilesPane } from './components/ProjectFilesPane'
import { BrowserPane } from './components/BrowserPane'
import { TabRail } from './components/TabRail'
import { TerminalPane } from './components/TerminalPane'
import { VoiceDock } from './components/VoiceDock'
import { SettingsSheet } from './components/SettingsSheet'
import { WelcomeSheet } from './components/WelcomeSheet'
import { WorkspaceSheet } from './components/WorkspaceSheet'
import { TabGrid } from './components/TabGrid'
import { getTheme, nextTheme } from '../shared/themes'
import {
  DEFAULT_PREFS,
  RAIL_MIN,
  RAIL_MAX,
  RAIL_DEFAULT,
  type Prefs,
  type WorkspacePane,
  type SavedTab,
  type TabInfo,
  type VoiceClip,
} from '../shared/types'
import type { JSX } from 'react'

function PaneIcon({kind}: {kind: 'browser' | 'files' | 'team' | 'terminal'}) {
  return <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {kind==='browser' ? <><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c5 5 5 13 0 18-5-5-5-13 0-18"/></> : kind==='files' ? <><path d="M4 3h10l5 5v13H4zM14 3v6h5M8 13h7M8 17h7"/></> : kind==='team' ? <><circle cx="9" cy="8" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3M16 5a3 3 0 0 1 0 6M18 15a5 5 0 0 1 3 6"/></> : <><path d="m5 6 6 6-6 6M13 18h6"/></>}
  </svg>
}

const MAX_CLIPS = 12

/** Push the active palette into CSS custom properties the stylesheet reads. */
function applyThemeVars(prefs: Prefs): void {
  const t = getTheme(prefs.theme)
  const root = document.documentElement.style
  root.setProperty('--bg', t.background)
  root.setProperty('--surface', t.surface)
  root.setProperty('--pane', t.pane)
  root.setProperty('--fg', t.foreground)
  root.setProperty('--dim', t.dim)
  root.setProperty('--accent', t.accent)
  root.setProperty('--border', t.border)
  root.setProperty('--shadow', t.shadow)
  root.setProperty('--ok', t.green)
  root.setProperty('--warn', t.yellow)
  root.setProperty('--danger', t.red)
  root.setProperty('--info', t.blue)
  document.documentElement.style.colorScheme = t.dark ? 'dark' : 'light'
}

export function App(): JSX.Element {
  const [prefs, setPrefs] = useState<Prefs>(DEFAULT_PREFS)
  const [ready, setReady] = useState(false)
  const [restored, setRestored] = useState(false)
  const [tabs, setTabs] = useState<TabInfo[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [clips, setClips] = useState<VoiceClip[]>([])
  const [playToken, setPlayToken] = useState(0)
  const [speakingId, setSpeakingId] = useState<string | null>(null)
  const workspace = useRef<HTMLDivElement>(null)
  const [compactWorkspace, setCompactWorkspace] = useState(false)
  const [compactPane, setCompactPane] = useState<'terminal' | 'browser' | 'files'>('terminal')
  const [filesDirty, setFilesDirty] = useState(false)
  const [filesWidth, setFilesWidth] = useState(280)
  const [browserWidth, setBrowserWidth] = useState(360)
  const [resizingPane, setResizingPane] = useState(false)
  const [showFiles, setShowFiles] = useState(false)
  const [openFileRequest, setOpenFileRequest] = useState<string | null>(null)
  useEffect(()=>{const open=(id:string)=>{setOpenFileRequest(id);setShowFiles(true);setBrowserOnly(false);setCompactPane('files')};void window.term.project.pending().then(id=>{if(id)open(id)});return window.term.project.onOpen(open)},[])
  useEffect(() => {
    const element = workspace.current
    if (!element) return
    const observer = new ResizeObserver(() => setCompactWorkspace(element.clientWidth < 850))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  const [showTerminal, setShowTerminal] = useState(true)
  const [showBrowser, setShowBrowser] = useState(false)
  const [browserOnly, setBrowserOnly] = useState(false)
  useEffect(()=>window.term.browser.onReveal(()=>{setShowBrowser(true);setCompactPane('browser')}),[])
  useEffect(() => {
    const tab = tabs.find(tab => tab.id === activeId)
    if (!tab) return
    let cancelled = false
    setShowTerminal(true); setBrowserOnly(false); setCompactPane('terminal')
    void window.term.browser.action('session', { owner: tab.browserKey || tab.id })
      .then(state => { if (!cancelled) setShowBrowser(Boolean(state.tabs?.length)) })
    return () => { cancelled = true }
  }, [activeId])
  const terminalVisible = showTerminal && !(browserOnly && showBrowser) && (!compactWorkspace || compactPane === 'terminal')
  const filesVisible = showFiles && !(browserOnly && showBrowser) && (!compactWorkspace || compactPane === 'files')
  const browserVisible = showBrowser && (!compactWorkspace || compactPane === 'browser')
  const toggleTerminal = () => {
    setShowTerminal(!terminalVisible); setBrowserOnly(false)
    setCompactPane(terminalVisible ? showBrowser ? 'browser' : showFiles ? 'files' : 'terminal' : 'terminal')
  }
  const toggleBrowserOnly = () => {
    setBrowserOnly(!browserOnly)
    if (browserOnly) setShowTerminal(true)
    setCompactPane(browserOnly ? 'terminal' : 'browser')
  }
  const toggleBrowser = () => {
    setShowBrowser(!browserVisible); setBrowserOnly(false)
    setCompactPane(browserVisible ? showTerminal ? 'terminal' : showFiles ? 'files' : 'browser' : 'browser')
  }
  const toggleFiles = () => {
    if (filesVisible && filesDirty && !window.confirm('Discard unsaved file changes?')) return
    setShowFiles(!filesVisible); setBrowserOnly(false)
    setCompactPane(filesVisible ? showTerminal ? 'terminal' : showBrowser ? 'browser' : 'files' : 'files')
  }

  const [showToolbar, setShowToolbar] = useState(false)
  const [fullscreen, setFullscreen] = useState(false)
  useEffect(() => { void window.term.window.fullscreen().then(setFullscreen); return window.term.window.onFullscreen(setFullscreen) }, [])
  const [showSettings, setShowSettings] = useState(false)
  const [showTeam, setShowTeam] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const [railWidth, setRailWidth] = useState(DEFAULT_PREFS.railWidth)
  const closedTabs = useRef<SavedTab[]>([])
  const [filter, setFilter] = useState('')
  const [filterOpen, setFilterOpen] = useState(false)
  const [showGrid, setShowGrid] = useState(false)

  // Kept in refs so the global key handler never closes over stale state.
  const tabsRef = useRef<TabInfo[]>([])
  const activeRef = useRef<string | null>(null)
  tabsRef.current = tabs
  activeRef.current = activeId

  const theme = getTheme(prefs.theme)

  // ---- prefs -------------------------------------------------------------
  useEffect(() => {
    void window.term.prefs.get().then((p) => {
      setPrefs(p)
      setRailWidth(p.railWidth)
      applyThemeVars(p)
      setReady(true)
    })
  }, [])

  const patchPrefs = useCallback((patch: Partial<Prefs>) => {
    setPrefs((prev) => {
      const next = {
        ...prev,
        ...patch,
        voice: { ...prev.voice, ...(patch.voice ?? {}) },
      }
      applyThemeVars(next)
      void window.term.prefs.set(patch)
      return next
    })
  }, [])

  const paneOrder = prefs.paneOrder
  const visiblePanes = paneOrder.filter(pane => ({ terminal: terminalVisible, browser: browserVisible, files: filesVisible })[pane])
  const filesSide = visiblePanes.indexOf('files') === visiblePanes.length - 1 ? 'right' : 'left'
  const browserSide = visiblePanes.indexOf('browser') === visiblePanes.length - 1 ? 'right' : 'left'
  const movePane = (pane: WorkspacePane, target: WorkspacePane) => {
    if (pane === target) return
    const next = [...paneOrder]
    next.splice(paneOrder.indexOf(target), 0, ...next.splice(paneOrder.indexOf(pane), 1))
    patchPrefs({ paneOrder: next })
  }
  const stepPane = (pane: WorkspacePane, direction: number) => {
    const target = paneOrder[paneOrder.indexOf(pane) + direction]
    if (target) movePane(pane, target)
  }

  // ---- tabs --------------------------------------------------------------
  const newTab = useCallback(async (cwd?: string, restore?: SavedTab) => {
    const browserKey = restore?.browserKey || crypto.randomUUID()
    const { id, cwd: realCwd } = await window.term.pty.create({
      cwd, browserKey,
      cols: 80,
      rows: 24,
    })
    const now = Date.now()
    const tab: TabInfo = {
      id, browserKey,
      customTitle: restore?.customTitle || restore?.name,
      agent: restore?.agent, agentSession: restore?.agentSession, agentArgs: restore?.agentArgs,
      title: restore?.customTitle || restore?.name || restore?.title || realCwd.split('/').filter(Boolean).slice(-1)[0] || 'shell',
      cwd: realCwd,
      process: '',
      status: 'ready',
      usedClaude: false,
      exited: false,
      createdAt: now,
      // Focus time carries across restarts; the session age deliberately does not.
      focusedMs: restore?.focusedMs ?? 0,
      lastActiveAt: now,
      notes: restore?.notes ?? '',
      claudeSession: '',
    }
    setTabs((prev) => [...prev, tab])
    setActiveId(id)

    const kind = restore?.agent || (restore?.claude ? 'claude' : '')
    if (kind && restore) {
      const sessionId = restore.agentSession || restore.claudeSession || ''
      const cmd = await window.term.pty.resumeCommand({ kind, sessionId, args: restore.agentArgs })
      setTabs(prev => prev.map(t=>t.id===id?{...t, agent:kind, agentSession:sessionId, agentArgs:restore.agentArgs||[]}:t))
      window.term.pty.exec(id, cmd)
    }
    return id
  }, [])

  /**
   * Take over a shell that is still running from before the window closed. No
   * spawn, and deliberately no `claude --resume`: the conversation was never
   * interrupted, so typing anything into it would land in a live prompt.
   */
  const adoptTab = useCallback((live: { id: string; cwd: string }, restore?: SavedTab) => {
    const now = Date.now()
    setTabs((prev) => [
      ...prev,
      {
        id: live.id,
        customTitle: restore?.customTitle || restore?.name,
      browserKey: restore?.browserKey || live.id,
      agent: restore?.agent, agentSession: restore?.agentSession, agentArgs: restore?.agentArgs,
      title: restore?.customTitle || restore?.name || restore?.title || live.cwd.split('/').filter(Boolean).slice(-1)[0] || 'shell',
        cwd: live.cwd,
        process: '',
        status: 'ready',
        usedClaude: false,
        exited: false,
        createdAt: now,
        focusedMs: restore?.focusedMs ?? 0,
        lastActiveAt: now,
        notes: restore?.notes ?? '',
        claudeSession: '',
      },
    ])
    setActiveId(live.id)
  }, [])

  const closeTab = useCallback(async (id: string) => {
    const agent = await window.term.pty.agent(id)
    if (agent.alive && !window.confirm('An agent is still running in this tab. Close it? You can reopen it with ⇧⌘T.')) return
    const tab = tabsRef.current.find(t=>t.id===id)
    if (tab) closedTabs.current = [{...tab, ptyId: tab.id, claude: tab.usedClaude}, ...closedTabs.current].slice(0,10)
    window.term.pty.close(id)
    setTabs((prev) => {
      const next = prev.filter((t) => t.id !== id)
      setActiveId((cur) => {
        if (cur !== id) return cur
        const idx = prev.findIndex((t) => t.id === id)
        return next[Math.min(idx, next.length - 1)]?.id ?? null
      })
      return next
    })
  }, [])

  // Restore the previous session's tabs, or open one in $HOME on a first run.
  const reopenTab = useCallback(async () => {
    const saved = closedTabs.current.shift()
    if (!saved) return
    const live = saved.ptyId ? await window.term.pty.unclose(saved.ptyId) : null
    if (live) adoptTab(live, saved); else await newTab(saved.cwd, saved)
  }, [adoptTab, newTab])

  const bootstrapped = useRef(false)
  useEffect(() => {
    if (!ready || bootstrapped.current) return
    bootstrapped.current = true
    void (async () => {
      // Shells outlive the window on macOS, so prefer adopting one over
      // restarting it. After a real quit this list is empty and every tab
      // takes the spawn-and-resume path below.
      const live = new Map((await window.term.pty.list()).map((s) => [s.id, s]))
      const launch = await window.term.app.launch()
      if (launch.crashed && prefs.tabs.length && !live.size && !window.confirm('TerminAI did not quit cleanly. Restore your saved sessions? Choose Cancel to start a fresh shell.')) { await newTab(); setRestored(true); return }
      const taken = new Set<string>()

      // Tabs saved before the app learned to mint session ids have none, and
      // `--continue` would put every one of them on the newest conversation in
      // the folder. Deal them the folder's conversations instead, newest to the
      // tab nearest the top, so each comes back somewhere different.
      const needIds = prefs.tabs.filter((t) => t.claude && !t.claudeSession)
      const dealt = new Map<SavedTab, string>()
      for (const cwd of new Set(needIds.map((t) => t.cwd))) {
        const forCwd = needIds.filter((t) => t.cwd === cwd)
        const ids = await window.term.pty.recentSessions(cwd, forCwd.length)
        forCwd.forEach((t, i) => ids[i] && dealt.set(t, ids[i]))
      }

      for (const raw of prefs.tabs) {
        const t = dealt.has(raw) ? { ...raw, claudeSession: dealt.get(raw) } : raw
        const running = t.ptyId ? live.get(t.ptyId) : undefined
        if (running) {
          taken.add(running.id)
          adoptTab(running, t)
        } else {
          await newTab(t.cwd, t)
        }
      }

      // A session with no saved tab: opened and then closed out of prefs, or
      // prefs lost. Still a running shell, so surface it rather than orphan it.
      for (const s of live.values()) if (!taken.has(s.id)) adoptTab(s)

      if (!prefs.tabs.length && !live.size) await newTab()
      setRestored(true)
    })()
  }, [ready, prefs.tabs, newTab, adoptTab])

  // Persist the tab set. Keyed on the saved fields alone: `tabs` also carries
  // live status, which changes several times a second, and writing prefs.json
  // at that rate would hammer the disk for no gain.
  const saved = tabs.map((t) => ({
    ptyId: t.id,
    cwd: t.cwd,
    title: t.title,
    customTitle: t.customTitle,
    browserKey: t.browserKey || t.id,
    agent: t.agent, agentSession: t.agentSession, agentArgs: t.agentArgs,
    notes: t.notes,
    focusedMs: t.focusedMs,
    claude: t.usedClaude,
    claudeSession: t.claudeSession,
  }))
  const savedKey = JSON.stringify(saved)
  const lastSaved = useRef('')
  useEffect(() => {
    if (!ready || !restored || !bootstrapped.current) return
    if (savedKey === lastSaved.current) return
    lastSaved.current = savedKey
    void window.term.prefs.set({ tabs: JSON.parse(savedKey) as SavedTab[] })
  }, [savedKey, ready, restored])

  useEffect(() => {
    window.term.tabs.setActive(activeId)
  }, [activeId])

  // Bank the time the outgoing tab spent focused, and start the incoming one's
  // clock. Doing it on switch rather than on a timer keeps it exact and cheap.
  const prevActive = useRef<string | null>(null)
  useEffect(() => {
    const now = Date.now()
    const leaving = prevActive.current
    prevActive.current = activeId
    if (leaving === activeId) return
    setTabs((prev) =>
      prev.map((t) => {
        if (t.id === leaving) return { ...t, focusedMs: t.focusedMs + (now - t.lastActiveAt) }
        if (t.id === activeId) return { ...t, lastActiveAt: now }
        return t
      }),
    )
  }, [activeId])

  // A dead PTY marks its row rather than yanking it out from under the user.
  useEffect(() => {
    return window.term.pty.onExit((id) => {
      setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, exited: true } : t)))
    })
  }, [])

  // Poll the foreground process so each row can show what it's doing.
  useEffect(() => {
    const iv = setInterval(() => {
      void (async () => {
        const live = tabsRef.current.filter((t) => !t.exited)
        if (!live.length) return
        const seen = await Promise.all(
          live.map(async (t) => ({
            id: t.id,
            process: await window.term.pty.process(t.id),
            status: await window.term.pty.status(t.id),
            agent: await window.term.pty.agent(t.id),
            usedClaude: await window.term.pty.usedClaude(t.id),
            cwd: await window.term.pty.cwd(t.id),
            // Only worth a read once Claude has actually run here; before that
            // there is no id file to find.
            claudeSession: t.usedClaude ? await window.term.pty.claudeSession(t.id) : '',
          })),
        )
        setTabs((prev) =>
          prev.map((t) => {
            const s = seen.find((x) => x.id === t.id)
            if (!s) return t
            const changed = !!s.agent.kind ||
              s.process !== t.process ||
              s.cwd !== t.cwd ||
              s.status !== t.status ||
              s.usedClaude !== t.usedClaude ||
              (s.claudeSession !== '' && s.claudeSession !== t.claudeSession)
            return changed
              ? {
                  ...t,
                  process: s.process,
                  cwd: s.cwd,
                  status: s.status,
                  agent: s.agent.kind || t.agent, agentSession: s.agent.sessionId || t.agentSession, agentArgs: s.agent.kind ? s.agent.args : t.agentArgs,
                  usedClaude: s.usedClaude,
                  claudeSession: s.claudeSession || t.claudeSession,
                }
              : t
          }),
        )
      })()
      // Fast enough that "working" turning into "wants you" reads as immediate.
    }, 800)
    return () => clearInterval(iv)
  }, [])

  const setTitle = useCallback((id: string, title: string) => {
    const clean = title.trim()
    if (!clean) return
    setTabs((prev) => prev.map((t) => (t.id === id && !t.customTitle ? { ...t, title: clean } : t)))
  }, [])

  // ---- voice -------------------------------------------------------------
  useEffect(() => {
    const offClip = window.term.voice.onClip((clip) => {
      setClips((prev) => [clip, ...prev].slice(0, MAX_CLIPS))
      if (prefs.voice.autoplay) setPlayToken((n) => n + 1)
    })
    const offErr = window.term.voice.onError((message) => {
      setToast(`Voice: ${message}`)
      setTimeout(() => setToast(null), 4500)
    })
    return () => {
      offClip()
      offErr()
    }
  }, [prefs.voice.autoplay])

  const onPlayingChange = useCallback((clip: VoiceClip | null) => {
    setSpeakingId(clip?.tabId ?? null)
  }, [])

  const reorderTabs = useCallback((from: number, to: number) => {
    setTabs((prev) => {
      const next = [...prev]
      const [moved] = next.splice(from, 1)
      if (moved) next.splice(to, 0, moved)
      return next
    })
  }, [])

  const setNotes = useCallback((id: string, notes: string) => {
    setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, notes } : t)))
  }, [])

  /**
   * Opens a tab in this app's own source tree and starts Claude Code there,
   * pointed at DESIGN.md. That file tells it what is safe to restyle, what must
   * keep working, and to run scripts/apply.sh — which rebuilds, reinstalls and
   * relaunches the app, ending this very session in the process.
   */
  const customizeDesign = useCallback(async () => {
    const repo = await window.term.design.repo()
    if (!repo.exists) {
      setToast("Cannot find this app's source tree to edit")
      setTimeout(() => setToast(null), 4500)
      return
    }
    setShowSettings(false)
    const id = await newTab(repo.path)
    // Give the login shell a moment to print its prompt before typing at it.
    setTimeout(() => {
      window.term.pty.write(
        id,
        "claude 'Read DESIGN.md first, then help me restyle this terminal. Ask me what I want to change.'\r",
      )
    }, 700)
  }, [newTab])

  // ---- rail resize -------------------------------------------------------
  // Pointer capture rather than window listeners, so the drag keeps tracking
  // once the cursor crosses into the terminal pane, which has its own handlers.
  // Width is tracked in local state during the drag and only written to
  // prefs.json on release.
  const startDrag = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault()
      const handle = e.currentTarget
      handle.setPointerCapture(e.pointerId)
      const originX = e.clientX
      const originW = railWidth
      let latest = railWidth

      // With the rail on the right, dragging left is what widens it, so the
      // delta is inverted on that side.
      const sign = prefs.railSide === 'right' ? -1 : 1
      const move = (ev: PointerEvent): void => {
        latest = Math.min(
          RAIL_MAX,
          Math.max(RAIL_MIN, Math.round(originW + sign * (ev.clientX - originX))),
        )
        setRailWidth(latest)
      }
      const up = (): void => {
        handle.removeEventListener('pointermove', move)
        handle.removeEventListener('pointerup', up)
        patchPrefs({ railWidth: latest })
      }
      handle.addEventListener('pointermove', move)
      handle.addEventListener('pointerup', up)
    },
    [railWidth, patchPrefs, prefs.railSide],
  )

  // A file dropped anywhere but a terminal would otherwise make the window
  // navigate to it, replacing the whole app with the file's contents.
  useEffect(() => {
    const swallow = (e: DragEvent): void => e.preventDefault()
    window.addEventListener('dragover', swallow)
    window.addEventListener('drop', swallow)
    return () => {
      window.removeEventListener('dragover', swallow)
      window.removeEventListener('drop', swallow)
    }
  }, [])

  // ---- keybindings -------------------------------------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const list = tabsRef.current
      const cur = list.findIndex((t) => t.id === activeRef.current)

      // ⌃⇥ / ⌃⇧⇥ cycle. Everything else here is ⌘-based, which no TUI claims.
      if (e.ctrlKey && e.key === 'Tab' && list.length) {
        e.preventDefault()
        const step = e.shiftKey ? -1 : 1
        setActiveId(list[(cur + step + list.length) % list.length]!.id)
        return
      }

      if (!e.metaKey) return

      // Terminal.app and iTerm both use ⌘⇧[ / ⌘⇧] to walk tabs. Shift turns the
      // brackets into braces on a US layout, so both forms have to be accepted.
      if (list.length && ['[', ']', '{', '}'].includes(e.key)) {
        e.preventDefault()
        const step = e.key === '[' || e.key === '{' ? -1 : 1
        setActiveId(list[(cur + step + list.length) % list.length]!.id)
        return
      }

      if (e.key.toLowerCase() === 't' && e.shiftKey) { e.preventDefault(); void reopenTab(); return }
      if (e.key.toLowerCase() === 'f') { e.preventDefault(); setFilterOpen(v=>!v); return }
      switch (e.key) {
        case 't':
          e.preventDefault()
          void newTab(list[cur]?.cwd)
          break
        case 'w':
          e.preventDefault()
          if (activeRef.current) closeTab(activeRef.current)
          break
        case ',':
          e.preventDefault()
          setShowSettings((s) => !s)
          break
        case 'g':
        case 'G':
          e.preventDefault()
          setShowGrid((g) => !g)
          break
        case 'L':
        case 'l':
          if (!e.shiftKey) return
          e.preventDefault()
          patchPrefs({ theme: nextTheme(prefs.theme) })
          break
        case 'S':
        case 's':
        case 'ß': // ⌥S on a US layout reports as ß
          e.preventDefault()
          // ⇧⌘S replays the last summary, ⌥⌘S swaps the rail's edge, and plain
          // ⌘S collapses it.
          if (e.shiftKey) setPlayToken((n) => n + 1)
          else if (e.altKey)
            patchPrefs({
              railSide: prefs.railSide === 'right' ? 'left' : 'right',
            })
          else patchPrefs({ railHidden: !prefs.railHidden })
          break
        case 'd':
        case 'D':
          e.preventDefault()
          patchPrefs({ voiceDockHidden: !prefs.voiceDockHidden })
          break
        case 'm':
        case 'M':
          // Plain ⌘M is macOS's minimize, so mute takes the shifted form.
          if (!e.shiftKey) return
          e.preventDefault()
          patchPrefs({
            voice: { ...prefs.voice, enabled: !prefs.voice.enabled },
          })
          break
        case 'o':
        case 'O':
          if (!e.shiftKey) return
          e.preventDefault()
          void window.term.dialog.pickFolder().then((dir) => dir && newTab(dir))
          break
        case '=':
        case '+':
          e.preventDefault()
          patchPrefs({ fontSize: Math.min(prefs.fontSize + 1, 24) })
          break
        case '-':
          e.preventDefault()
          patchPrefs({ fontSize: Math.max(prefs.fontSize - 1, 9) })
          break
        default: {
          const n = Number(e.key)
          if (n >= 1 && n <= 9 && list[n - 1]) {
            e.preventDefault()
            setActiveId(list[n - 1]!.id)
          }
        }
      }
    }

    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [
    newTab,
    closeTab,
    reopenTab,
    patchPrefs,
    prefs.theme,
    prefs.fontSize,
    prefs.railHidden,
    prefs.railSide,
    prefs.voiceDockHidden,
    prefs.voice,
  ])

  return (
    <div className={`app rail-${prefs.railSide}${fullscreen ? ' window-fullscreen' : ''}`}>
      {!prefs.railHidden && (
        <>
          <TabRail
            tabs={tabs}
            filter={filterOpen ? filter : ''} onFilter={setFilter} filterOpen={filterOpen}
            onRename={(id,title)=>setTabs(prev=>prev.map(t=>t.id===id?{...t,title,customTitle:title}:t))}
            onReorderGroups={(from,to)=>setTabs(prev=>{const order=[...new Set(prev.map(t=>t.cwd))];const a=order.indexOf(from),b=order.indexOf(to);if(a<0||b<0)return prev;order.splice(b,0,...order.splice(a,1));return order.flatMap(cwd=>prev.filter(t=>t.cwd===cwd))})}
            activeId={terminalVisible ? activeId : null}
            speakingId={speakingId}
            width={railWidth}
            onSelect={id=>{if(id===activeId)toggleTerminal();else setActiveId(id)}}
            onClose={closeTab}
            onNew={() => void newTab(tabs.find((t) => t.id === activeId)?.cwd)}
            onNewIn={() => void window.term.dialog.pickFolder().then((dir) => dir && newTab(dir))}
            onSettings={() => setShowSettings(true)}
            onReorder={(from,to)=>{if(!prefs.groupByFolder){reorderTabs(from,to);return}setTabs(prev=>{if(prev[from]?.cwd!==prev[to]?.cwd)return prev;const slots=prev.map((t,i)=>t.cwd===prev[from]?.cwd?i:-1).filter(i=>i>=0);const list=slots.map(i=>prev[i]);list.splice(slots.indexOf(to),0,...list.splice(slots.indexOf(from),1));const next=[...prev];slots.forEach((slot,i)=>next[slot]=list[i]);return next})}}
            grouped={prefs.groupByFolder}
          />

          {/* Lives in the gutter rather than inside the rail: the rail clips its
              own overflow, which would swallow half the grip's hit area. */}
          <div
            className="rail-grip"
            style={prefs.railSide === 'right' ? { right: railWidth + 7 } : { left: railWidth + 7 }}
            onPointerDown={startDrag}
            onDoubleClick={() => {
              setRailWidth(RAIL_DEFAULT)
              patchPrefs({ railWidth: RAIL_DEFAULT })
            }}
            title="Drag to resize · double-click to reset"
          />
        </>
      )}

      <main className="stage">
        {/* The traffic lights are pinned to the window's top-left by macOS, so
            with the rail on the right this strip is what keeps them off the
            terminal. It doubles as the window's drag handle. */}
        <div className="topbar" onContextMenu={event => { event.preventDefault(); setShowToolbar(true) }} onDoubleClick={event => { if (!(event.target as HTMLElement).closest('button,input')) void window.term.window.toggleMaximize() }}>
          {/* Only reserve traffic-light room when they actually land on the
              stage — with the rail visible on the left, it holds them instead. */}
          <span className="topbar-gap" />
          <div className="workspace-tabs" role="group" aria-label="Workspace panes">
            {paneOrder.filter(pane => !prefs.hiddenToolbarItems.includes(pane)).map(pane => <button key={pane} className="btn icon no-drag" draggable
              aria-label={pane === 'terminal' ? 'Terminal' : pane === 'browser' ? 'Browser' : 'Files'}
              aria-pressed={({ terminal: terminalVisible, browser: browserVisible, files: filesVisible })[pane]}
              title={`${pane === 'terminal' ? 'Terminal' : pane === 'browser' ? 'Browser' : 'Files'} · click to show/hide · drag to reorder · ⌥←/→ to move`}
              onClick={({ terminal: toggleTerminal, browser: toggleBrowser, files: toggleFiles })[pane]}
              onDragStart={event => { event.dataTransfer.setData('application/x-terminai-pane', pane); event.dataTransfer.effectAllowed = 'move'; setResizingPane(true) }}
              onDragEnd={() => setResizingPane(false)}
              onDragOver={event => { if (event.dataTransfer.types.includes('application/x-terminai-pane')) event.preventDefault() }}
              onDrop={event => { event.preventDefault(); const from = event.dataTransfer.getData('application/x-terminai-pane') as WorkspacePane; if (paneOrder.includes(from)) movePane(from, pane); setResizingPane(false) }}
              onKeyDown={event => { if (event.altKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) { event.preventDefault(); stepPane(pane, event.key === 'ArrowLeft' ? -1 : 1) } }}
            ><PaneIcon kind={pane} /></button>)}
          </div>
          {!prefs.hiddenToolbarItems.includes('team') && <button className="btn icon no-drag" aria-label="Team" title="Team" onClick={() => setShowTeam(true)}><PaneIcon kind="team" /></button>}
          <span className="topbar-spacer" />
          {!prefs.hiddenToolbarItems.includes('maximize') && <button className="btn icon no-drag" title="Maximise or restore window" aria-label="Maximise or restore window" onClick={()=>void window.term.window.toggleMaximize()}>↗</button>}
          {!prefs.hiddenToolbarItems.includes('sessions') && <button
            className="btn icon"
            onClick={() => setShowGrid((g) => !g)}
            title="All sessions  ⌘G"
          >
            ⊞
          </button>}
          {!prefs.hiddenToolbarItems.includes('sidebar') && <button
            className="btn icon"
            onClick={() => patchPrefs({ railHidden: !prefs.railHidden })}
            title={`${prefs.railHidden ? 'Show' : 'Hide'} sidebar  ⌘S`}
          >
            {prefs.railHidden ? '⇤' : '⇥'}
          </button>}
          <button className="btn icon no-drag" title="Customize toolbar" aria-label="Customize toolbar" aria-expanded={showToolbar} onClick={() => setShowToolbar(value => !value)}>⋯</button>
          {prefs.railHidden && (
            <button className="btn icon" onClick={() => setShowSettings(true)} title="Settings  ⌘,">
              ⚙
            </button>
          )}
        </div>

        <div ref={workspace} className={`workspace ${compactWorkspace ? 'compact-workspace' : ''}`}>
        {showFiles && <div className={`files-slot ${!filesVisible ? 'workspace-hidden' : ''}`} style={{ order: paneOrder.indexOf('files'), width: compactWorkspace ? undefined : filesWidth, flex: compactWorkspace ? undefined : !terminalVisible ? '1 1 auto' : '0 1 auto' }}>{visiblePanes.length > 1 && !compactWorkspace && filesSide === 'right' && <PaneResizeHandle label="Resize files" width={filesWidth} sign={-1} onChange={setFilesWidth} onDrag={setResizingPane} />}<ProjectFilesPane openRequest={openFileRequest} onDirty={setFilesDirty} side={filesSide} onSide={() => movePane('files', paneOrder[filesSide === 'left' ? paneOrder.length - 1 : 0])} onClose={() => { setShowFiles(false); setCompactPane('terminal') }} />{visiblePanes.length > 1 && !compactWorkspace && filesSide === 'left' && <PaneResizeHandle label="Resize files" width={filesWidth} sign={1} onChange={setFilesWidth} onDrag={setResizingPane} />}</div>}
        <div className={`pane ${!terminalVisible ? 'workspace-hidden' : ''}`} style={{ order: paneOrder.indexOf('terminal') }}>
          {tabs.length === 0 && (
            <div className="pane-empty">
              <div>No sessions open</div>
              <button
                className="btn primary"
                style={{ flex: '0 0 auto' }}
                onClick={() => void newTab()}
              >
                New tab ⌘T
              </button>
            </div>
          )}
          {tabs.map((tab) => (
            <TerminalPane
              key={tab.id}
              ptyId={tab.id}
              active={tab.id === activeId && terminalVisible}
              theme={theme}
              fontSize={prefs.fontSize}
              onTitle={(title) => setTitle(tab.id, title)}
            />
          ))}
        </div>

        {showBrowser && <div className={`browser-slot ${compactWorkspace && compactPane !== 'browser' ? 'workspace-hidden' : ''}`} style={{ order: paneOrder.indexOf('browser'), width: compactWorkspace ? undefined : browserWidth, flex: compactWorkspace ? undefined : !terminalVisible && !filesVisible ? '1 1 auto' : '0 1 auto' }}>{visiblePanes.length > 1 && !compactWorkspace && browserSide === 'right' && <PaneResizeHandle label="Resize browser" width={browserWidth} sign={-1} onChange={setBrowserWidth} onDrag={setResizingPane} />}<BrowserPane browserOnly={browserOnly} onToggleOnly={toggleBrowserOnly} layoutKey={`${prefs.railSide}-${prefs.railHidden}-${railWidth}-${prefs.voiceDockHidden}-${showFiles}-${paneOrder.join()}-${compactWorkspace}-${compactPane}-${browserOnly}-${showTerminal}`}  visible={browserVisible && !resizingPane && !showSettings && !showGrid && !showTeam && !showToolbar && !(ready && !prefs.seenWelcome)} onClose={() => { setShowBrowser(false); setCompactPane('terminal') }} />{visiblePanes.length > 1 && !compactWorkspace && browserSide === 'left' && <PaneResizeHandle label="Resize browser" width={browserWidth} sign={1} onChange={setBrowserWidth} onDrag={setResizingPane} />}</div>}
        {!terminalVisible && !browserVisible && !filesVisible && <div className="workspace-empty">Choose Terminal, Browser or Files above to show a pane.</div>}
        </div>

        {prefs.voice.enabled && (
          <VoiceDock
            clips={clips}
            autoplay={prefs.voice.autoplay}
            enabled={prefs.voice.enabled}
            volume={prefs.voice.volume}
            playToken={playToken}
            hidden={prefs.voiceDockHidden}
            onPlayingChange={onPlayingChange}
            onToggleAutoplay={() =>
              patchPrefs({
                voice: { ...prefs.voice, autoplay: !prefs.voice.autoplay },
              })
            }
            onToggleEnabled={() =>
              patchPrefs({
                voice: { ...prefs.voice, enabled: !prefs.voice.enabled },
              })
            }
          />
        )}
      </main>

      {showToolbar && <div className="toolbar-customize-backdrop" onClick={() => setShowToolbar(false)}>
        <section className="toolbar-customize" role="dialog" aria-label="Customize toolbar" onClick={event => event.stopPropagation()}>
          <strong>Customize toolbar</strong><p>Choose icons to show. Drag the pane icons to reorder them.</p>
          {(['terminal','browser','files','team','sessions','maximize','sidebar'] as const).map(item => <label key={item}><input type="checkbox" checked={!prefs.hiddenToolbarItems.includes(item)} onChange={event => patchPrefs({ hiddenToolbarItems: event.target.checked ? prefs.hiddenToolbarItems.filter(value => value !== item) : [...prefs.hiddenToolbarItems, item] })} />{item === 'terminal' ? 'Code' : item.charAt(0).toUpperCase() + item.slice(1)}</label>)}
          <div><button className="btn" onClick={() => patchPrefs({ hiddenToolbarItems: [] })}>Reset</button><button className="btn" onClick={() => setShowToolbar(false)}>Done</button></div>
        </section>
      </div>}

      {/* First run only. Waits for `ready` so it never flashes over an empty
          window before prefs have loaded. */}
      {ready && !prefs.seenWelcome && (
        <WelcomeSheet
          onOpenWorkspace={() => { patchPrefs({ seenWelcome: true }); setShowTeam(true) }}
          onDismiss={() => patchPrefs({ seenWelcome: true })}
          onOpenSettings={() => {
            patchPrefs({ seenWelcome: true })
            setShowSettings(true)
          }}
        />
      )}

      {showTeam && <WorkspaceSheet activeTab={tabs.find(tab => tab.id === activeId)} onClose={() => setShowTeam(false)} />}
      {showSettings && (
        <SettingsSheet
          prefs={prefs}
          onChange={patchPrefs}
          onClose={() => setShowSettings(false)}
          onCustomize={() => void customizeDesign()}
        />
      )}

      {showGrid && (
        <TabGrid
          tabs={tabs}
          activeId={activeId}
          onSelect={(id) => {
            setActiveId(id)
            setShowTerminal(true); setBrowserOnly(false); setCompactPane('terminal')
            setShowGrid(false)
          }}
          onClose={closeTab}
          onReorder={reorderTabs}
          onNotes={setNotes}
          onNew={() => void newTab(tabs.find((t) => t.id === activeId)?.cwd)}
          onClose_={() => setShowGrid(false)}
        />
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  )
}
