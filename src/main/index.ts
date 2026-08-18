import { app, BrowserWindow, ipcMain, dialog, shell, nativeTheme, protocol, net } from 'electron'
import { join, basename, resolve, sep } from 'node:path'
import { existsSync } from 'node:fs'
import { copyFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { pathToFileURL } from 'node:url'
import * as ptys from './pty'
import * as store from './store'
import * as voice from './voice'
import { availableVoices } from './tts/say'
import {
  hasKey as hasElevenKey,
  listVoices as listElevenVoices,
  forgetKey as forgetElevenKey,
  KEYCHAIN_SERVICE,
} from './tts/elevenlabs'
import * as localTts from './tts/local'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
import { getTheme } from '../shared/themes'
import type { Prefs, VoicePrefs } from '../shared/types'

/** Injected by electron-vite at build time; see electron.vite.config.ts. */
declare const __REPO_ROOT__: string

let win: BrowserWindow | null = null
/** Tracked so a voice clip can be attributed to the tab that likely produced it. */
let activeTabId: string | null = null

// Must run before app-ready, or the scheme is treated as opaque and <audio>
// refuses to seek within it.
protocol.registerSchemesAsPrivileged([
  {
    scheme: voice.AUDIO_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
])

/** Serves only files that really live inside the voice cache directory. */
function registerAudioProtocol(): void {
  protocol.handle(voice.AUDIO_SCHEME, (request) => {
    const dir = voice.cacheDir()
    const name = basename(decodeURIComponent(new URL(request.url).pathname))
    const file = resolve(dir, name)
    if (file !== resolve(dir, basename(file)) || !file.startsWith(dir + sep)) {
      return new Response('forbidden', { status: 403 })
    }
    return net.fetch(pathToFileURL(file).toString())
  })
}

function createWindow(): void {
  const prefs = store.load()
  const theme = getTheme(prefs.theme)

  win = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 720,
    minHeight: 420,
    show: false,
    // Rounded, chromeless shell with the traffic lights floated over the rail.
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 18 },
    backgroundColor: theme.background,
    vibrancy: theme.dark ? 'under-window' : 'sidebar',
    visualEffectState: 'active',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // A summary must play the moment it arrives; there is no click to gate it on.
      autoplayPolicy: 'no-user-gesture-required',
    },
  })

  win.once('ready-to-show', () => win?.show())

  // Links in terminal output open in the real browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  voice.startWatching(
    win.webContents,
    () => store.load().voice,
    () => ptys.liveIds().map((id) => ({ id, cwd: ptys.cwdOf(id) })),
  )
}

app.whenReady().then(() => {
  registerAudioProtocol()
  registerIpc()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  voice.stopWatching()
  if (process.platform !== 'darwin') {
    ptys.killAll()
    app.quit()
    return
  }
  // On macOS closing the window is not quitting. Leave every shell running and
  // only drop the window binding: reopening from the Dock then adopts the same
  // sessions, mid-command and mid-conversation, instead of restarting them.
  ptys.detachAll()
})

app.on('before-quit', () => {
  voice.stopWatching()
  ptys.killAll()
})

function registerIpc(): void {
  // ---- terminal ----------------------------------------------------------
  ipcMain.handle('pty:create', (_e, opts: { cwd?: string; cols?: number; rows?: number }) =>
    ptys.createSession(opts ?? {}),
  )
  ipcMain.handle('pty:list', () => ptys.list())
  ipcMain.handle('pty:attach', (e, { id }: { id: string }) => ptys.attach(e.sender, id))
  ipcMain.on('pty:write', (_e, { id, data }: { id: string; data: string }) => ptys.write(id, data))
  ipcMain.on('pty:resize', (_e, { id, cols, rows }: { id: string; cols: number; rows: number }) =>
    ptys.resize(id, cols, rows),
  )
  ipcMain.on('pty:kill', (_e, { id }: { id: string }) => ptys.kill(id))
  ipcMain.handle('pty:process', (_e, { id }: { id: string }) => ptys.foregroundProcess(id))
  ipcMain.handle('pty:status', (_e, { id }: { id: string }) => ptys.statusOf(id))
  ipcMain.handle('pty:usedClaude', (_e, { id }: { id: string }) => ptys.usedClaude(id))
  ipcMain.handle('pty:cwd', (_e, { id }: { id: string }) => ptys.cwdOf(id))
  ipcMain.handle('pty:claudeSession', (_e, { id }: { id: string }) => ptys.claudeSessionOf(id))
  ipcMain.handle(
    'pty:recentSessions',
    (_e, { cwd, limit }: { cwd: string; limit: number }) => ptys.recentClaudeSessions(cwd, limit),
  )
  ipcMain.handle('pty:canResume', (_e, { sessionId }: { sessionId: string }) =>
    ptys.claudeSessionExists(sessionId),
  )
  ipcMain.on('tab:active', (_e, { id }: { id: string | null }) => {
    activeTabId = id
  })

  // ---- prefs -------------------------------------------------------------
  ipcMain.handle('prefs:get', () => store.load())
  ipcMain.handle('prefs:set', (_e, patch: Partial<Prefs>) => {
    const next = store.save(patch)
    if (win && patch.theme) {
      const theme = getTheme(next.theme)
      win.setBackgroundColor(theme.background)
      // Keep the traffic lights and any native surfaces on the right side of
      // light/dark, or they invert against the new palette.
      nativeTheme.themeSource = theme.dark ? 'dark' : 'light'
      win.setVibrancy(theme.dark ? 'under-window' : 'sidebar')
    }
    return next
  })

  // ---- voice -------------------------------------------------------------
  ipcMain.handle('voice:speak', async (_e, { text }: { text: string }) => {
    const prefs = store.load().voice
    const { path, engine } = await voice.synthesize(text, prefs)
    return voice.toClip(text, path, engine, activeTabId)
  })
  ipcMain.handle('voice:voices', () => availableVoices())
  ipcMain.handle('voice:hasElevenKey', () => hasElevenKey())
  ipcMain.handle('voice:hasLocal', () => localTts.isAvailable())
  ipcMain.handle('voice:elevenVoices', async () => {
    try {
      return { ok: true as const, voices: await listElevenVoices() }
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
    }
  })
  ipcMain.handle('voice:setElevenKey', async (_e, { key }: { key: string }) => {
    const trimmed = key.trim()
    try {
      if (trimmed) {
        // -U updates in place if the item already exists.
        await execFileAsync('security', [
          'add-generic-password',
          '-U',
          '-s',
          KEYCHAIN_SERVICE,
          '-a',
          'clipwave-term',
          '-w',
          trimmed,
        ])
      } else {
        await execFileAsync('security', ['delete-generic-password', '-s', KEYCHAIN_SERVICE])
      }
      forgetElevenKey()
      return { ok: true as const }
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) }
    }
  })
  ipcMain.handle('voice:save', async (_e, { path, text }: { path: string; text: string }) => {
    if (!win) return { saved: false }
    const suggested = `${text.slice(0, 48).replace(/[^\w\s-]/g, '').trim() || 'summary'}${
      path.endsWith('.mp3') ? '.mp3' : '.wav'
    }`
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      defaultPath: join(homedir(), 'Downloads', suggested),
    })
    if (canceled || !filePath) return { saved: false }
    await copyFile(path, filePath)
    return { saved: true, filePath }
  })

  // ---- design customisation ---------------------------------------------
  ipcMain.handle('design:repo', () => {
    const root = typeof __REPO_ROOT__ === 'string' ? __REPO_ROOT__ : ''
    return { path: root, exists: Boolean(root) && existsSync(join(root, 'DESIGN.md')) }
  })

  // ---- misc --------------------------------------------------------------
  ipcMain.handle('dialog:pickFolder', async () => {
    if (!win) return null
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      properties: ['openDirectory', 'createDirectory'],
    })
    return canceled ? null : (filePaths[0] ?? null)
  })
}

export type { VoicePrefs }
