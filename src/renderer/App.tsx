import { useCallback, useEffect, useRef, useState } from 'react'
import { TabRail } from './components/TabRail'
import { TerminalPane } from './components/TerminalPane'
import { VoiceDock } from './components/VoiceDock'
import { SettingsSheet } from './components/SettingsSheet'
import { getTheme } from '../shared/themes'
import {
  DEFAULT_PREFS,
  RAIL_MIN,
  RAIL_MAX,
  RAIL_DEFAULT,
  type Prefs,
  type TabInfo,
  type VoiceClip,
} from '../shared/types'
import type { JSX } from 'react'

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
  document.documentElement.style.colorScheme = t.dark ? 'dark' : 'light'
}

export function App(): JSX.Element {
  const [prefs, setPrefs] = useState<Prefs>(DEFAULT_PREFS)
  const [ready, setReady] = useState(false)
  const [tabs, setTabs] = useState<TabInfo[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [clips, setClips] = useState<VoiceClip[]>([])
  const [playToken, setPlayToken] = useState(0)
  const [speakingId, setSpeakingId] = useState<string | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const [railWidth, setRailWidth] = useState(DEFAULT_PREFS.railWidth)

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
      const next = { ...prev, ...patch, voice: { ...prev.voice, ...(patch.voice ?? {}) } }
      applyThemeVars(next)
      void window.term.prefs.set(patch)
      return next
    })
  }, [])

  // ---- tabs --------------------------------------------------------------
  const newTab = useCallback(async (cwd?: string) => {
    const { id, cwd: realCwd } = await window.term.pty.create({ cwd, cols: 80, rows: 24 })
    const tab: TabInfo = {
      id,
      title: realCwd.split('/').filter(Boolean).slice(-1)[0] || 'shell',
      cwd: realCwd,
      process: '',
      exited: false,
    }
    setTabs((prev) => [...prev, tab])
    setActiveId(id)
    return id
  }, [])

  const closeTab = useCallback((id: string) => {
    window.term.pty.kill(id)
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
  const bootstrapped = useRef(false)
  useEffect(() => {
    if (!ready || bootstrapped.current) return
    bootstrapped.current = true
    void (async () => {
      if (prefs.tabs.length) {
        for (const t of prefs.tabs) await newTab(t.cwd)
      } else {
        await newTab()
      }
    })()
  }, [ready, prefs.tabs, newTab])

  // Persist the tab set (not on every keystroke — only when it actually changes).
  useEffect(() => {
    if (!ready || !bootstrapped.current) return
    void window.term.prefs.set({ tabs: tabs.map((t) => ({ cwd: t.cwd, title: t.title })) })
  }, [tabs, ready])

  useEffect(() => {
    window.term.tabs.setActive(activeId)
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
            cwd: await window.term.pty.cwd(t.id),
          })),
        )
        setTabs((prev) =>
          prev.map((t) => {
            const s = seen.find((x) => x.id === t.id)
            return s && (s.process !== t.process || s.cwd !== t.cwd)
              ? { ...t, process: s.process, cwd: s.cwd }
              : t
          }),
        )
      })()
    }, 1500)
    return () => clearInterval(iv)
  }, [])

  const setTitle = useCallback((id: string, title: string) => {
    const clean = title.trim()
    if (!clean) return
    setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, title: clean } : t)))
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

      const move = (ev: PointerEvent): void => {
        latest = Math.min(RAIL_MAX, Math.max(RAIL_MIN, Math.round(originW + ev.clientX - originX)))
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
    [railWidth, patchPrefs],
  )

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
        case 'L':
        case 'l':
          if (!e.shiftKey) return
          e.preventDefault()
          patchPrefs({ theme: prefs.theme === 'dusk' ? 'paper' : 'dusk' })
          break
        case 'S':
        case 's':
          if (!e.shiftKey) return
          e.preventDefault()
          setPlayToken((n) => n + 1)
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
  }, [newTab, closeTab, patchPrefs, prefs.theme, prefs.fontSize])

  return (
    <div className="app">
      <TabRail
        tabs={tabs}
        activeId={activeId}
        speakingId={speakingId}
        width={railWidth}
        onSelect={setActiveId}
        onClose={closeTab}
        onNew={() => void newTab(tabs.find((t) => t.id === activeId)?.cwd)}
        onNewIn={() => void window.term.dialog.pickFolder().then((dir) => dir && newTab(dir))}
        onSettings={() => setShowSettings(true)}
      />

      {/* Lives in the gutter rather than inside the rail: the rail clips its own
          overflow, which would swallow half the grip's hit area. */}
      <div
        className="rail-grip"
        style={{ left: railWidth + 7 }}
        onPointerDown={startDrag}
        onDoubleClick={() => {
          setRailWidth(RAIL_DEFAULT)
          patchPrefs({ railWidth: RAIL_DEFAULT })
        }}
        title="Drag to resize · double-click to reset"
      />

      <main className="stage">
        <div className="pane">
          {tabs.length === 0 && (
            <div className="pane-empty">
              <div>No sessions open</div>
              <button className="btn primary" style={{ flex: '0 0 auto' }} onClick={() => void newTab()}>
                New tab ⌘T
              </button>
            </div>
          )}
          {tabs.map((tab) => (
            <TerminalPane
              key={tab.id}
              ptyId={tab.id}
              active={tab.id === activeId}
              theme={theme}
              fontSize={prefs.fontSize}
              onTitle={(title) => setTitle(tab.id, title)}
            />
          ))}
        </div>

        {prefs.voice.enabled && (
          <VoiceDock
            clips={clips}
            autoplay={prefs.voice.autoplay}
            volume={prefs.voice.volume}
            playToken={playToken}
            onPlayingChange={onPlayingChange}
            onToggleAutoplay={() => patchPrefs({ voice: { ...prefs.voice, autoplay: !prefs.voice.autoplay } })}
          />
        )}
      </main>

      {showSettings && (
        <SettingsSheet prefs={prefs} onChange={patchPrefs} onClose={() => setShowSettings(false)} />
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  )
}
