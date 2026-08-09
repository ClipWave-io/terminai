import { useCallback, useEffect, useRef, useState } from 'react'
import { TabRail } from './components/TabRail'
import { TerminalPane } from './components/TerminalPane'
import { VoiceDock } from './components/VoiceDock'
import { SettingsSheet } from './components/SettingsSheet'
import { WelcomeSheet } from './components/WelcomeSheet'
import { TabGrid } from './components/TabGrid'
import { getTheme, nextTheme } from '../shared/themes'
import {
  DEFAULT_PREFS,
  RAIL_MIN,
  RAIL_MAX,
  RAIL_DEFAULT,
  type Prefs,
  type SavedTab,
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
  root.setProperty('--info', t.blue)
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

  // ---- tabs --------------------------------------------------------------
  const newTab = useCallback(async (cwd?: string, restore?: SavedTab) => {
    const { id, cwd: realCwd } = await window.term.pty.create({
      cwd,
      cols: 80,
      rows: 24,
    })
    const now = Date.now()
    const tab: TabInfo = {
      id,
      title: restore?.title || realCwd.split('/').filter(Boolean).slice(-1)[0] || 'shell',
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

    // The tab was mid-conversation when the app last closed. Resume it rather
    // than leaving the session stranded behind a bare prompt.
    if (restore?.claude) {
      // Resume *this tab's* conversation by id. `--continue` picks the most
      // recent conversation in the folder, so several tabs on one folder would
      // all land on the same one and the rest would be lost. Fall back to it
      // only when we never learned an id, or the transcript is gone.
      const saved = restore.claudeSession
      const cmd =
        saved && (await window.term.pty.canResume(saved))
          ? `claude --resume ${saved}`
          : 'claude --continue'
      // The delay lets the login shell finish printing its prompt first, so the
      // command is not typed into a half-initialised line.
      setTimeout(() => window.term.pty.write(id, `${cmd}\r`), 900)
    }
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
        for (const t of prefs.tabs) await newTab(t.cwd, t)
      } else {
        await newTab()
      }
    })()
  }, [ready, prefs.tabs, newTab])

  // Persist the tab set. Keyed on the saved fields alone: `tabs` also carries
  // live status, which changes several times a second, and writing prefs.json
  // at that rate would hammer the disk for no gain.
  const saved = tabs.map((t) => ({
    cwd: t.cwd,
    title: t.title,
    notes: t.notes,
    focusedMs: t.focusedMs,
    claude: t.usedClaude,
    claudeSession: t.claudeSession,
  }))
  const savedKey = JSON.stringify(saved)
  const lastSaved = useRef('')
  useEffect(() => {
    if (!ready || !bootstrapped.current) return
    if (savedKey === lastSaved.current) return
    lastSaved.current = savedKey
    void window.term.prefs.set({ tabs: JSON.parse(savedKey) as SavedTab[] })
  }, [savedKey, ready])

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
            const changed =
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
    patchPrefs,
    prefs.theme,
    prefs.fontSize,
    prefs.railHidden,
    prefs.railSide,
    prefs.voiceDockHidden,
    prefs.voice,
  ])

  return (
    <div className={`app rail-${prefs.railSide}`}>
      {!prefs.railHidden && (
        <>
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
            onReorder={reorderTabs}
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
        <div className="topbar">
          {/* Only reserve traffic-light room when they actually land on the
              stage — with the rail visible on the left, it holds them instead. */}
          {(prefs.railSide === 'right' || prefs.railHidden) && <span className="topbar-gap" />}
          <span className="topbar-title">{tabs.find((t) => t.id === activeId)?.title ?? ''}</span>
          <button
            className="btn icon"
            onClick={() => setShowGrid((g) => !g)}
            title="All sessions  ⌘G"
          >
            ⊞
          </button>
          <button
            className="btn icon"
            onClick={() => patchPrefs({ railHidden: !prefs.railHidden })}
            title={`${prefs.railHidden ? 'Show' : 'Hide'} sidebar  ⌘S`}
          >
            {prefs.railHidden ? '⇤' : '⇥'}
          </button>
          {prefs.voice.enabled && (
            <button
              className="btn icon"
              onClick={() => patchPrefs({ voiceDockHidden: !prefs.voiceDockHidden })}
              title={`${prefs.voiceDockHidden ? 'Show' : 'Hide'} voice dock  ⌘D`}
            >
              ∿
            </button>
          )}
          {prefs.railHidden && (
            <button className="btn icon" onClick={() => setShowSettings(true)} title="Settings  ⌘,">
              ⚙
            </button>
          )}
        </div>

        <div className="pane">
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

      {/* First run only. Waits for `ready` so it never flashes over an empty
          window before prefs have loaded. */}
      {ready && !prefs.seenWelcome && (
        <WelcomeSheet
          onDismiss={() => patchPrefs({ seenWelcome: true })}
          onOpenSettings={() => {
            patchPrefs({ seenWelcome: true })
            setShowSettings(true)
          }}
        />
      )}

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
