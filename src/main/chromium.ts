import { app, screen, type BrowserWindow } from 'electron'
import { importFromChrome, chromeProfiles, checkChromeAccess, type ImportResult } from './chrome-import'
import { spawn, execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, readFileSync, readdirSync, writeFileSync, renameSync, rmSync } from 'node:fs'
import { mkdir, rename, rm, writeFile, readFile, chmod } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

/**
 * TerminAI Browser: our own Chromium (scripts/build-browser.sh), a real browser beside the app, because TerminAI's
 * Electron pane cannot run Chrome Web Store extensions (no native messaging, no chrome.debugger). Here it runs
 * Claude in Chrome, password managers and every other extension; agents drive it through its DevTools port
 * (Playwright MCP, registered for Claude Code below).
 *
 * Downloaded on first use from the pinned GitHub release asset, checked against its SHA-256, kept in userData with its
 * own profile. The DevTools port listens on 127.0.0.1 only.
 */
export const BROWSER = {
  version: '159.0.8154.0',
  url: 'https://github.com/ClipWave-io/terminai/releases/download/browser-v159.0.8154.0-onespace/TerminAI-Browser-159.0.8154.0-arm64.zip',
  sha256: 'f5d1594478068670482c772e15efdcb5779925d12cc8a2ec03cdb22056d6f6b7',
  bundleId: 'com.clipwave.term.browser',
  port: 9347,
}
// The extension IDs Anthropic's native hosts accept (Claude in Chrome: store, beta, internal), as Claude Code writes them.
const CLAUDE_EXTENSIONS = ['fcoeoabgfenejglbffodgkkbkcdhcgfn', 'dihbgbndebgnbjfmelmegjepbnkhlgni', 'dngcpimnedloihjnnfngkgjoidhnaolf']

export type ChromiumStatus = { state: 'missing' | 'downloading' | 'installed' | 'running' | 'error'; progress?: number; message?: string; endpoint?: string; version: string
  /** shown inside TerminAI's browser pane (the browser window glued onto it) rather than as a window of its own */
  inPane?: boolean
  /** false: an agent put it in the pane without bringing the pane forward */
  reveal?: boolean }
export type PaneRect = { x: number; y: number; width: number; height: number; visible: boolean }

export function createChromium(window: () => BrowserWindow | null) {
  const root = join(app.getPath('userData'), 'TerminAI Browser')
  const appPath = join(root, 'TerminAI Browser.app'), binary = join(appPath, 'Contents/MacOS/Chromium')
  const profile = join(root, 'Profile'), marker = join(root, 'installed.json')
  let status: ChromiumStatus = { state: 'missing', version: BROWSER.version }
  let installing: Promise<void> | null = null
  const publish = (next: Partial<ChromiumStatus>) => {
    status = { ...status, ...next }
    const w = window(); if (w && !w.isDestroyed()) w.webContents.send('chromium:status', { ...status, reveal })
  }
  const installed = () => { try { return JSON.parse(readFileSync(marker, 'utf8')).sha256 === BROWSER.sha256 && existsSync(binary) } catch { return false } }
  const endpoint = `http://127.0.0.1:${BROWSER.port}`
  const alive = async () => {
    try {
      const r = await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(800) })
      const v = await r.json() as { Browser?: string }
      // Something else on our port (another Chromium, a dev server) is not our browser.
      return r.ok && typeof v.Browser === 'string' && v.Browser.includes(BROWSER.version.split('.')[0])
    } catch { return false }
  }

  async function download() {
    await mkdir(root, { recursive: true })
    const zip = join(root, 'download.zip'), staging = join(root, 'staging')
    publish({ state: 'downloading', progress: 0, message: 'Downloading TerminAI Browser…' })
    const res = await fetch(BROWSER.url, { signal: AbortSignal.timeout(15 * 60_000) })
    if (!res.ok || !res.body) throw Error(`Download failed (HTTP ${res.status})`)
    const total = Number(res.headers.get('content-length')) || 0
    let got = 0, last = 0
    const body = Readable.fromWeb(res.body as any)
    body.on('data', (chunk: Buffer) => { got += chunk.length; const p = total ? Math.floor(got / total * 100) : 0; if (p !== last) { last = p; publish({ progress: p }) } })
    await pipeline(body, createWriteStream(zip))
    const hash = createHash('sha256'); await pipeline(createReadStream(zip), hash)
    if (hash.digest('hex') !== BROWSER.sha256) { await rm(zip, { force: true }); throw Error('The download did not match its checksum') }
    await rm(staging, { recursive: true, force: true }); await mkdir(staging)
    await new Promise<void>((resolve, reject) => execFile('/usr/bin/ditto', ['-x', '-k', zip, staging], e => e ? reject(Error('Could not unpack the browser')) : resolve()))
    await rm(appPath, { recursive: true, force: true })
    await rename(join(staging, 'TerminAI Browser.app'), appPath)
    await rm(staging, { recursive: true, force: true }); await rm(zip, { force: true })
    await writeFile(marker, JSON.stringify({ version: BROWSER.version, sha256: BROWSER.sha256 }))
    publish({ state: 'installed', progress: 100, message: undefined })
  }
  function install() {
    if (installed()) return Promise.resolve()
    installing ??= download().catch(e => { publish({ state: 'error', message: e instanceof Error ? e.message : 'Download failed' }); throw e }).finally(() => { installing = null })
    return installing
  }

  /** Claude in Chrome reaches Claude Code (and the Claude app) through native hosts; Chromium looks for them in the profile. */
  async function nativeHosts() {
    const dir = join(profile, 'NativeMessagingHosts'); await mkdir(dir, { recursive: true })
    const origins = CLAUDE_EXTENSIONS.map(id => `chrome-extension://${id}/`)
    const hosts: [string, string, string][] = [
      ['com.anthropic.claude_code_browser_extension', 'Claude Code Browser Extension Native Host', join(homedir(), '.claude/chrome/chrome-native-host')],
      ['com.anthropic.claude_browser_extension', 'Claude Browser Extension Native Host', '/Applications/Claude.app/Contents/Helpers/chrome-native-host'],
    ]
    for (const [name, description, path] of hosts) if (existsSync(path))
      await writeFile(join(dir, `${name}.json`), JSON.stringify({ name, description, path, type: 'stdio', allowed_origins: origins }, null, 2))
    // Other apps' hosts installed for Chrome (password managers and so on) work here too when they accept any browser.
    for (const source of [join(homedir(), 'Library/Application Support/Google/Chrome/NativeMessagingHosts'), '/Library/Google/Chrome/NativeMessagingHosts']) {
      let names: string[] = []; try { names = readdirSync(source).filter(n => n.endsWith('.json') && !n.startsWith('com.anthropic.')) } catch {}
      for (const n of names) { try { if (!existsSync(join(dir, n))) await writeFile(join(dir, n), await readFile(join(source, n))) } catch {} }
    }
  }

  /**
   * Claude in Chrome comes preinstalled: Chromium installs a Web Store extension listed in its "External Extensions"
   * folder from the store on its next start (Chromium may ask once to turn it on). Removing it there is respected:
   * Chromium does not bring back an external extension the person uninstalled.
   */
  async function preinstall() {
    const dir = join(profile, 'External Extensions'); await mkdir(dir, { recursive: true })
    const file = join(dir, `${CLAUDE_EXTENSIONS[0]}.json`)
    if (!existsSync(file)) await writeFile(file, JSON.stringify({ external_update_url: 'https://clients2.google.com/service/update2/crx' }))
  }

  /**
   * Inside TerminAI: the browser process loads native/browser-glue.m (shipped in the browser app), which keeps its window
   * on the pane whose place TerminAI writes to glue.json. A browser built before the glue gets docked beside instead.
   */
  const glueLib = join(appPath, 'Contents/Frameworks/TerminAIGlue.dylib'), glueFile = join(root, 'glue.json')
  let pane: PaneRect | null = null, lastGlue = '', launching = false
  const glueRunning = () => { try { const pid = Number(readFileSync(`${glueFile}.ack`, 'utf8')); process.kill(pid, 0); return pid > 0 } catch { return false } }
  function writeGlue() {
    const w = window()
    let next: object = { mode: 'hidden' }
    if (!status.inPane) next = { mode: background ? 'hidden' : 'free' }
    else if (w && !w.isDestroyed() && pane?.visible && w.isVisible() && !w.isMinimized() && pane.width > 50 && pane.height > 50) {
      const c = w.getContentBounds(), top = c.y + pane.y, primary = screen.getPrimaryDisplay().bounds
      const target = Number(/^window:(\d+):/.exec(w.getMediaSourceId())?.[1] || 0)
      // Cocoa's screen points count up from the bottom of the main display.
      next = { mode: 'glued', target, x: Math.round(c.x + pane.x), y: Math.round(primary.height - top - pane.height), w: Math.round(pane.width), h: Math.round(pane.height) }
    }
    const json = JSON.stringify(next); if (json === lastGlue) return
    lastGlue = json
    try { writeFileSync(`${glueFile}.tmp`, json); renameSync(`${glueFile}.tmp`, glueFile) } catch {}
  }
  /** The browser pane's place in the window (renderer coordinates), or null when it is not on screen. */
  function setPane(rect: PaneRect | null) { pane = rect; writeGlue() }
  /** Show it in the pane (true) or as a window of its own again (false, "Pop out"). */
  function setInPane(on: boolean) { background = false; wantPane = on; publish({ inPane: on && glueRunning() }); writeGlue() }
  let wantPane = false
  // false: put in the pane without showing it (an agent not allowed to bring the browser forward)
  let reveal = true
  // Started at TerminAI's launch, out of sight, so the pane is instant when it is asked for.
  let background = false
  setInterval(() => {
    // The browser's own TerminAI menu: "Show Inside TerminAI" / "Open in Its Own Window".
    let req = ''; try { req = readFileSync(`${glueFile}.req`, 'utf8').trim(); rmSync(`${glueFile}.req`, { force: true }) } catch {}
    if (req === 'pane' && glueRunning()) { setInPane(true); const w = window(); if (w && !w.isDestroyed()) { if (w.isMinimized()) w.restore(); w.show(); app.focus({ steal: true }) } }
    else if (req === 'free') setInPane(false)
    // Its × in the tab strip: the pane closes, the browser keeps running hidden for the agents.
    else if (req === 'close') { const w = window(); if (w && !w.isDestroyed()) w.webContents.send('chromium:closePane') }
    // Quit from its own menu: the pane closes too.
    if (status.inPane && !launching && !glueRunning() && status.state !== 'downloading') { wantPane = false; publish({ inPane: false, state: 'installed' }); lastGlue = ''; writeGlue() }
    // A first start can take longer than the launch waited: it goes into the pane as soon as the glue answers.
    else if (wantPane && !status.inPane && !launching && glueRunning()) { follow(); publish({ inPane: true }); lastGlue = ''; writeGlue() }
  }, 700).unref()
  let watching: BrowserWindow | null = null
  function follow() {
    const w = window(); if (!w || w === watching) return
    watching = w
    for (const e of ['move', 'resize', 'moved', 'resized', 'minimize', 'restore', 'hide', 'show', 'focus', 'enter-full-screen', 'leave-full-screen'] as const) w.on(e as 'move', () => { lastGlue = ''; writeGlue() })
    w.on('closed', () => { watching = null; lastGlue = ''; pane = null; writeGlue() })
  }

  async function waitAlive(ms: number) { const end = Date.now() + ms; while (Date.now() < end) { if (await alive()) return true; await new Promise(r => setTimeout(r, 250)) } return false }

  /** Opens the browser (installing it first if needed) with `url` in a new tab, beside the TerminAI window. */
  async function open(url?: string, quiet = false) {
    reveal = !quiet
    await install()
    if (url && !/^https?:\/\//i.test(url)) throw Error('Only http and https links open in TerminAI Browser')
    if (await alive()) {
      if (url) await fetch(`${endpoint}/json/new?${encodeURI(url)}`, { method: 'PUT' }).catch(() => {})
      if (glueRunning()) { follow(); setInPane(true) } else execFile('/usr/bin/open', ['-b', BROWSER.bundleId])
    } else {
      await nativeHosts(); await preinstall().catch(() => {})
      // With the glue the window goes straight into the pane: hidden until the pane says where it is.
      const glue = existsSync(glueLib)
      launching = true
      if (glue) { await rm(`${glueFile}.ack`, { force: true }); follow(); wantPane = true; publish({ inPane: true }); lastGlue = ''; writeGlue() }
      const child = spawn(binary, [`--user-data-dir=${profile}`, `--remote-debugging-port=${BROWSER.port}`, '--remote-debugging-address=127.0.0.1',
        '--no-first-run', '--no-default-browser-check', ...(url ? [url] : [])], { detached: true, stdio: 'ignore',
        env: existsSync(glueLib) ? { ...process.env, DYLD_INSERT_LIBRARIES: glueLib, TERMINAI_GLUE_FILE: glueFile } : process.env })
      child.unref()
      if (!await waitAlive(15_000)) { launching = false; publish({ inPane: false }); throw Error('TerminAI Browser did not start') }
      // The glue answers within a moment of the window opening; without it the window is placed beside TerminAI.
      for (let i = 0; i < 100 && existsSync(glueLib) && !glueRunning(); i++) await new Promise(r => setTimeout(r, 150))
      launching = false
      if (glueRunning()) setInPane(true)
      else if (!existsSync(glueLib)) { publish({ inPane: false }); writeGlue(); await dock().catch(() => {}) }
      else { publish({ inPane: false }); writeGlue() }
    }
    publish({ state: 'running', endpoint })
    return status
  }

  /** At TerminAI's start, for someone who uses TerminAI Browser: it starts hidden, so opening the pane later is instant. */
  async function prewarm(): Promise<void> {
    if (!installed() || !existsSync(glueLib) || await alive()) return
    background = true; wantPane = false; lastGlue = ''; writeGlue()
    await rm(`${glueFile}.ack`, { force: true }); await nativeHosts().catch(() => {}); await preinstall().catch(() => {})
    spawn(binary, [`--user-data-dir=${profile}`, `--remote-debugging-port=${BROWSER.port}`, '--remote-debugging-address=127.0.0.1', '--no-first-run', '--no-default-browser-check'],
      { detached: true, stdio: 'ignore', env: { ...process.env, DYLD_INSERT_LIBRARIES: glueLib, TERMINAI_GLUE_FILE: glueFile } }).unref()
    if (await waitAlive(20_000)) { follow(); publish({ state: 'running', endpoint, inPane: false }) }
  }

  /** The browser window takes the right half of the TerminAI window, the way the Files pane sits beside the tabs. */
  async function dock() {
    const w = window(); if (!w || w.isDestroyed()) return
    const b = w.getBounds(), half = Math.floor(b.width / 2)
    const target = (await (await fetch(`${endpoint}/json/list`)).json() as { type: string; webSocketDebuggerUrl: string }[]).find(t => t.type === 'page')
    if (!target) return
    const ws = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
    let id = 0
    const call = (method: string, params: object) => new Promise<any>(resolve => { const n = ++id; ws.addEventListener('message', e => { const m = JSON.parse(String(e.data)); if (m.id === n) resolve(m.result) }); ws.send(JSON.stringify({ id: n, method, params })) })
    const { windowId } = await call('Browser.getWindowForTarget', {})
    await call('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } })
    await call('Browser.setWindowBounds', { windowId, bounds: { left: b.x + half, top: b.y, width: b.width - half, height: b.height } })
    ws.close()
  }

  async function current(): Promise<ChromiumStatus> {
    if (status.state === 'downloading') return status
    if (await alive()) return { ...status, state: 'running', endpoint }
    return { ...status, state: installed() ? 'installed' : status.state === 'error' ? 'error' : 'missing', endpoint: undefined }
  }

  /**
   * Claude Code drives the browser through Playwright MCP over the DevTools port, with passwords from a 0600 secrets
   * file filled in by name (the model never sees the values). The launcher only starts Playwright MCP, which connects on
   * its first browser call: starting a Claude session must never open a browser window (`terminai browser open` does).
   */
  async function registerMcp() {
    const launcher = join(root, 'mcp.sh'), secrets = join(homedir(), '.config/terminai-browser/secrets.env')
    await mkdir(root, { recursive: true }); await mkdir(join(homedir(), '.config/terminai-browser'), { recursive: true })
    if (!existsSync(secrets)) await writeFile(secrets, '# NAME=value, one per line. Claude types the NAME; the browser fills the value.\n', { mode: 0o600 })
    const q = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`
    await writeFile(launcher, `#!/bin/sh\n# Written by TerminAI: Playwright MCP on TerminAI Browser's DevTools port (open the browser first).\n`
      + `exec npx -y @playwright/mcp@0.0.85 --cdp-endpoint ${endpoint} --secrets ${q(secrets)} --output-dir ${q(join(root, 'output'))}\n`)
    await chmod(launcher, 0o755)
    const file = join(homedir(), '.claude.json')
    try {
      const d = JSON.parse(await readFile(file, 'utf8'))
      d.mcpServers ??= {}
      const existing = d.mcpServers['terminai-browser']
      if (existing && existing.command === launcher) return
      if (existing) return // a user-made entry with this name is left alone
      d.mcpServers['terminai-browser'] = { type: 'stdio', command: launcher, args: [], env: {} }
      await writeFile(`${file}.terminai-tmp`, JSON.stringify(d, null, 2), { mode: 0o600 }); await rename(`${file}.terminai-tmp`, file)
    } catch {}
  }

  /** Import from Chrome: the browser closes (its files must not be in use), takes Chrome's logins, passwords and bookmarks, and opens again. */
  async function importChrome(from?: string): Promise<ImportResult> {
    // First whether Chrome's data can be read at all (Full Disk Access), before any download of the browser.
    await checkChromeAccess()
    await install()
    const wasRunning = await alive()
    if (wasRunning) {
      execFile('/usr/bin/pkill', ['-TERM', '-f', binary])
      for (let i = 0; i < 40 && await alive(); i++) await new Promise(r => setTimeout(r, 250))
      await new Promise(r => setTimeout(r, 800))
    }
    try { return await importFromChrome(profile, from) }
    finally { if (wasRunning) void open().catch(() => {}) }
  }

  return { open, install, current, registerMcp, setPane, setInPane, importChrome, chromeProfiles, prewarm, status: () => status }
}
