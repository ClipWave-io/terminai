import { app, type BrowserWindow } from 'electron'
import { spawn, execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, readFileSync, readdirSync } from 'node:fs'
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
  url: 'https://github.com/ClipWave-io/terminai/releases/download/browser-v159.0.8154.0/TerminAI-Browser-159.0.8154.0-arm64.zip',
  sha256: 'e0abb1f9ba1167909edd8fed893b8465e75e8cdd67f92f97460fdf5189a1710a',
  bundleId: 'com.clipwave.term.browser',
  port: 9347,
}
// The extension IDs Anthropic's native hosts accept (Claude in Chrome: store, beta, internal), as Claude Code writes them.
const CLAUDE_EXTENSIONS = ['fcoeoabgfenejglbffodgkkbkcdhcgfn', 'dihbgbndebgnbjfmelmegjepbnkhlgni', 'dngcpimnedloihjnnfngkgjoidhnaolf']

export type ChromiumStatus = { state: 'missing' | 'downloading' | 'installed' | 'running' | 'error'; progress?: number; message?: string; endpoint?: string; version: string }

export function createChromium(window: () => BrowserWindow | null) {
  const root = join(app.getPath('userData'), 'TerminAI Browser')
  const appPath = join(root, 'TerminAI Browser.app'), binary = join(appPath, 'Contents/MacOS/Chromium')
  const profile = join(root, 'Profile'), marker = join(root, 'installed.json')
  let status: ChromiumStatus = { state: 'missing', version: BROWSER.version }
  let installing: Promise<void> | null = null
  const publish = (next: Partial<ChromiumStatus>) => {
    status = { ...status, ...next }
    const w = window(); if (w && !w.isDestroyed()) w.webContents.send('chromium:status', status)
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

  async function waitAlive(ms: number) { const end = Date.now() + ms; while (Date.now() < end) { if (await alive()) return true; await new Promise(r => setTimeout(r, 250)) } return false }

  /** Opens the browser (installing it first if needed) with `url` in a new tab, beside the TerminAI window. */
  async function open(url?: string) {
    await install()
    if (url && !/^https?:\/\//i.test(url)) throw Error('Only http and https links open in TerminAI Browser')
    if (await alive()) {
      if (url) await fetch(`${endpoint}/json/new?${encodeURI(url)}`, { method: 'PUT' }).catch(() => {})
      execFile('/usr/bin/open', ['-b', BROWSER.bundleId])
    } else {
      await nativeHosts()
      const child = spawn(binary, [`--user-data-dir=${profile}`, `--remote-debugging-port=${BROWSER.port}`, '--remote-debugging-address=127.0.0.1',
        '--no-first-run', '--no-default-browser-check', ...(url ? [url] : [])], { detached: true, stdio: 'ignore' })
      child.unref()
      if (!await waitAlive(15_000)) throw Error('TerminAI Browser did not start')
      await dock().catch(() => {})
    }
    publish({ state: 'running', endpoint })
    return status
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

  return { open, install, current, registerMcp, status: () => status }
}
