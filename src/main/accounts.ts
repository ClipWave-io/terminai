import { execFile, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import { homedir } from 'node:os'
import { join } from 'node:path'
import * as pty from '@homebridge/node-pty-prebuilt-multiarch'
import * as ptys from './pty'
import type { AccountFlow, ChromeProfile, ClaudeAccount, ClaudeAccounts } from '../shared/types'

/**
 * The Claude Code accounts tabs can run on, so two tabs can sit on two plans and a tab whose plan
 * runs out carries on with the next one without Claude Code noticing. "login" is the sign-in
 * `/login` saved on this Mac; every other account is a one-year token from `claude setup-token`,
 * kept in the login keychain under KEYCHAIN_SERVICE and nowhere else: not in a file, not in the
 * renderer, not in a log.
 *
 * Claude Code in a TerminAI tab sends its model requests through the relay below (the claude shim
 * sets ANTHROPIC_BASE_URL to it, with the tab's workspace key in the path). The relay forwards them
 * to Anthropic unchanged, except that it signs /v1/messages with the account picked for the tab:
 * switching account takes effect on the next request, with nothing restarted. The saved login stays
 * Claude Code's credential for everything else, so connectors and Remote Control keep working.
 */
export const KEYCHAIN_SERVICE = 'TerminAI Claude account'
const SECURITY = '/usr/bin/security'
// Tests point the relay at a fake Anthropic.
const UPSTREAM = new URL(process.env.TERMINAI_RELAY_UPSTREAM || 'https://api.anthropic.com')
const TOKEN = /sk-ant-oat01-[A-Za-z0-9_-]{20,}(?=[^A-Za-z0-9_-])/
const FLOW_TIMEOUT_MS = 10 * 60_000

interface Saved { id: string; label: string; fp: string; addedAt: number }
interface State { mode: 'manual' | 'auto'; loginLabel?: string; accounts: Saved[]; exhausted: Record<string, number> }

const validId = (id: unknown): id is string => typeof id === 'string' && /^[0-9a-f-]{36}$/.test(id)
const validKey = (key: unknown): key is string => typeof key === 'string' && /^[0-9A-Za-z-]{1,80}$/.test(key)
const cleanLabel = (label: unknown) => typeof label === 'string' ? label.replace(/[^\p{L}\p{N} ._-]/gu, '').trim().slice(0, 40) : ''

/** The account `/login` saved, named after its owner until the user names it. */
function loginName(): string {
  try {
    const o = JSON.parse(readFileSync(join(homedir(), '.claude.json'), 'utf8')).oauthAccount ?? {}
    return cleanLabel(o.displayName) || cleanLabel(String(o.emailAddress ?? '').split('@')[0]) || 'Login'
  } catch {
    return 'Login'
  }
}

/** Chrome's own list of profiles, so a sign-in link opens in the one that holds the right account. */
export function chromeProfiles(): ChromeProfile[] {
  try {
    const cache = JSON.parse(readFileSync(join(homedir(), 'Library/Application Support/Google/Chrome/Local State'), 'utf8')).profile?.info_cache ?? {}
    return Object.entries<any>(cache).map(([dir, p]) => ({ dir, name: String(p?.name || dir) })).sort((a, b) => a.name.localeCompare(b.name))
  } catch {
    return []
  }
}

function keychainRead(id: string): Promise<string> {
  return new Promise(resolve => execFile(SECURITY, ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', id, '-w'], (e, out) => resolve(e ? '' : out.trim())))
}

/** Token in on stdin, never on a command line another process could read. */
function keychainSave(id: string, label: string, token: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(SECURITY, ['-i'], { stdio: ['pipe', 'ignore', 'pipe'] })
    let err = ''
    p.stderr.on('data', d => { err += d })
    p.on('error', reject)
    // `security -i` exits 0 even when a command failed: read the item back to know.
    p.on('exit', () => void keychainRead(id).then(saved => saved === token ? resolve() : reject(new Error(err.trim() || 'The keychain did not keep the token.'))))
    p.stdin.end(`add-generic-password -U -s "${KEYCHAIN_SERVICE}" -a ${id} -l "TerminAI Claude (${label})" -w ${token}\n`)
  })
}

function keychainDelete(id: string): Promise<void> {
  return new Promise(resolve => execFile(SECURITY, ['delete-generic-password', '-s', KEYCHAIN_SERVICE, '-a', id], () => resolve()))
}

export function createAccounts(userData: string, opts: { changed: () => void; flowChanged: (flow: AccountFlow) => void }) {
  const root = join(userData, 'accounts')
  const tabsDir = join(root, 'tabs')
  const file = join(root, 'accounts.json')
  mkdirSync(tabsDir, { recursive: true })

  const load = (): State => {
    try {
      const j = JSON.parse(readFileSync(file, 'utf8'))
      return {
        mode: j.mode === 'auto' ? 'auto' : 'manual',
        loginLabel: cleanLabel(j.loginLabel) || undefined,
        accounts: Array.isArray(j.accounts) ? j.accounts.filter((a: any) => validId(a?.id) && cleanLabel(a.label)) : [],
        exhausted: j.exhausted && typeof j.exhausted === 'object' ? j.exhausted : {},
      }
    } catch {
      return { mode: 'manual', accounts: [], exhausted: {} }
    }
  }
  const state = load()

  const ids = () => ['login', ...state.accounts.map(a => a.id)]
  const usable = (id: string) => !(state.exhausted[id] > Date.now())
  const labelOf = (id: string) => id === 'login' ? state.loginLabel || loginName() : state.accounts.find(a => a.id === id)?.label ?? ''
  // New tabs start on the login account; in automatic mode, on the first one with usage left.
  const defaultAccount = () => (state.mode === 'auto' ? ids().find(usable) : undefined) ?? 'login'
  const save = () => {
    const now = Date.now()
    for (const [id, until] of Object.entries(state.exhausted)) if (!(until > now) || !ids().includes(id)) delete state.exhausted[id]
    writeFileSync(`${file}.tmp`, JSON.stringify(state, null, 2), { mode: 0o600 })
    renameSync(`${file}.tmp`, file)
    // Read by statusline.sh, like the tab files: which account a tab is on when it has none of its own.
    writeFileSync(join(root, 'default'), defaultAccount())
    opts.changed()
  }
  save()

  function accountOfKey(key: string): string {
    try {
      const id = readFileSync(join(tabsDir, key), 'utf8').trim()
      if (ids().includes(id)) return id
    } catch {}
    return defaultAccount()
  }
  function setKey(key: string, id: string) {
    writeFileSync(join(tabsDir, key), id)
    opts.changed()
  }
  const forTab = (ptyId: string) => accountOfKey(ptys.workspaceKeyOf(ptyId))
  function use(ptyId: string, id: string) {
    if (!ids().includes(id)) throw new Error('Unknown account')
    setKey(ptys.workspaceKeyOf(ptyId), id)
  }
  /** The next account after this one, in menu order, that still has usage left. */
  function nextUsable(id: string): string {
    const order = ids(), at = order.indexOf(id)
    return [...order.slice(at + 1), ...order.slice(0, at)].find(usable) ?? ''
  }

  const usage = new Map<string, NonNullable<ClaudeAccount['usage']>>()
  function listing(): ClaudeAccounts {
    const now = Date.now()
    return {
      mode: state.mode,
      accounts: ids().map(id => ({ id, label: labelOf(id), login: id === 'login', exhaustedUntil: state.exhausted[id] > now ? state.exhausted[id] : 0, usage: usage.get(id) })),
    }
  }

  // ---- the relay ---------------------------------------------------------------
  const tokens = new Map<string, string>()
  const tokenOf = async (id: string) => {
    if (!tokens.has(id)) { const t = await keychainRead(id); if (t) tokens.set(id, t) }
    return tokens.get(id) ?? ''
  }
  const client = UPSTREAM.protocol === 'http:' ? http : https
  const agent = new client.Agent({ keepAlive: true })
  const limitHeader = (h: http.IncomingHttpHeaders, k: string) => Number(h[`anthropic-ratelimit-unified-${k}`])
  function send(req: http.IncomingMessage, res: http.ServerResponse, path: string, headers: http.OutgoingHttpHeaders, body: Buffer): Promise<http.IncomingMessage> {
    return new Promise((resolve, reject) => {
      const up = client.request({ protocol: UPSTREAM.protocol, hostname: UPSTREAM.hostname, port: UPSTREAM.port, path, method: req.method, headers, agent }, resolve)
      up.on('error', reject)
      // Esc in Claude Code drops the request: stop the upstream one too.
      res.on('close', () => { if (!res.writableFinished) up.destroy() })
      up.end(body)
    })
  }
  async function forward(key: string, path: string, req: http.IncomingMessage, res: http.ServerResponse, body: Buffer) {
    // Only model requests are signed with the tab's account; the rest keep the login's own credentials.
    const model = path.startsWith('/v1/messages')
    const tried = new Set<string>()
    for (;;) {
      let id = model ? accountOfKey(key) : 'login'
      if (model && state.mode === 'auto' && !usable(id)) {
        const next = nextUsable(id)
        if (next) { setKey(key, next); id = next }
      }
      tried.add(id)
      const headers: http.OutgoingHttpHeaders = { ...req.headers, host: UPSTREAM.host }
      // An account whose token is gone (removed from the keychain) falls back to the login.
      const token = id === 'login' ? '' : await tokenOf(id)
      if (token) headers.authorization = `Bearer ${token}`
      const r = await send(req, res, path, headers, body)
      const status = r.statusCode ?? 502
      // A plan or spend limit, as opposed to a passing throttle that Claude Code retries by itself.
      if (model && status === 429 && r.headers['anthropic-ratelimit-unified-status'] === 'rejected') {
        const reset = limitHeader(r.headers, 'reset')
        state.exhausted[id] = reset > 0 ? reset * 1000 : Date.now() + 5 * 3600_000
        save()
        const next = state.mode === 'auto' ? nextUsable(id) : ''
        if (next && !tried.has(next)) {
          r.resume()
          setKey(key, next)
          continue
        }
      }
      if (model && status < 400 && r.headers['anthropic-ratelimit-unified-status']) {
        usage.set(id, { fiveHour: limitHeader(r.headers, '5h-utilization') || 0, week: limitHeader(r.headers, '7d-utilization') || 0, at: Date.now() })
      }
      // Streamed through as it arrives: Claude Code stalls on a buffered response.
      res.writeHead(status, r.headers)
      r.pipe(res)
      return
    }
  }
  const relayUrlFile = join(root, 'relay-url')
  rmSync(relayUrlFile, { force: true })
  const relay = http.createServer((req, res) => {
    const m = /^\/([^/?]+)(\/[^]*)?$/.exec(req.url || '')
    if (!m || !validKey(m[1])) { res.writeHead(404).end(); return }
    const chunks: Buffer[] = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => {
      forward(m[1], m[2] || '/', req, res, Buffer.concat(chunks)).catch(err => {
        if (res.headersSent) { res.destroy(); return }
        res.writeHead(502, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: `TerminAI relay: ${String(err?.message || err)}` } }))
      })
    })
  })
  // Loopback only. The shim routes claude here only while this file exists, so a relay that
  // failed to start leaves the tabs on a direct connection.
  relay.listen(0, '127.0.0.1', () => {
    const address = relay.address()
    if (address && typeof address === 'object') writeFileSync(relayUrlFile, `http://127.0.0.1:${address.port}`)
  })

  // ---- adding an account ------------------------------------------------------
  const flows = new Map<string, { flow: AccountFlow; proc: pty.IPty; timer: NodeJS.Timeout; poll: NodeJS.Timeout; urlFile: string }>()
  function emit(id: string, patch: Partial<AccountFlow>) {
    const f = flows.get(id)
    if (!f) return
    f.flow = { ...f.flow, ...patch }
    opts.flowChanged(f.flow)
  }
  function endFlow(id: string) {
    const f = flows.get(id)
    if (!f) return
    clearTimeout(f.timer)
    clearInterval(f.poll)
    try { f.proc.kill() } catch {}
    rmSync(f.urlFile, { force: true })
    flows.delete(id)
  }
  function add(rawLabel: unknown): AccountFlow {
    const label = cleanLabel(rawLabel)
    if (!label) throw new Error('Give the account a name.')
    const id = randomUUID()
    const urlFile = join(root, `oauth-${id}.url`)
    // claude hands the sign-in link to $BROWSER: catching it here is what lets the user pick the
    // Chrome profile, instead of it opening in whichever profile was used last.
    const helper = join(root, 'open-url.sh')
    writeFileSync(helper, '#!/bin/sh\nprintf \'%s\\n\' "$1" > "$TERMINAI_OAUTH_URL_FILE"\n', { mode: 0o755 })
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) if (typeof v === 'string' && !k.startsWith('CLAUDE_CODE_') && k !== 'CLAUDECODE' && k !== 'CLAUDE_PID' && !k.startsWith('ELECTRON_')) env[k] = v
    Object.assign(env, { TERM: 'xterm-256color', BROWSER: helper, TERMINAI_OAUTH_URL_FILE: urlFile })
    // Interactive, because ~/.zshrc is where claude's folder joins the PATH. 400 columns keep the token on one line.
    const proc = pty.spawn(process.env.SHELL || '/bin/zsh', ['-ilc', 'exec claude setup-token'], { name: 'xterm-256color', cols: 400, rows: 50, cwd: homedir(), env })
    const flow: AccountFlow = { id, label, stage: 'starting' }
    let raw = '', done = false
    proc.onData(data => {
      if (done) return
      raw = (raw + data).slice(-65536)
      const token = TOKEN.exec(raw)?.[0]
      if (!token) return
      done = true
      raw = ''
      keychainSave(id, label, token).then(() => {
        state.accounts.push({ id, label, fp: createHash('sha256').update(token).digest('hex').slice(0, 10), addedAt: Date.now() })
        save()
        emit(id, { stage: 'saved', url: undefined })
      }, err => emit(id, { stage: 'error', error: String(err?.message || err) })).finally(() => endFlow(id))
    })
    proc.onExit(() => { if (!done) { emit(id, { stage: 'error', error: 'Claude stopped before giving a token.' }); endFlow(id) } })
    const poll = setInterval(() => {
      try {
        const url = readFileSync(urlFile, 'utf8').trim()
        if (/^https:\/\/claude\.(ai|com)\//.test(url) && flows.get(id)?.flow.url !== url) emit(id, { stage: 'waiting', url })
      } catch {}
    }, 300)
    const timer = setTimeout(() => { emit(id, { stage: 'error', error: 'Nobody approved the sign-in within 10 minutes.' }); endFlow(id) }, FLOW_TIMEOUT_MS)
    flows.set(id, { flow, proc, timer, poll, urlFile })
    return flow
  }
  function openInChrome(flowId: string, profileDir: string) {
    const url = flows.get(flowId)?.flow.url
    if (!url) throw new Error('The sign-in link is not ready yet.')
    if (!chromeProfiles().some(p => p.dir === profileDir)) throw new Error('Unknown Chrome profile')
    execFile('open', ['-na', 'Google Chrome', '--args', `--profile-directory=${profileDir}`, url])
  }
  const cancel = (flowId: string) => endFlow(flowId)

  async function remove(id: string) {
    if (!validId(id) || !state.accounts.some(a => a.id === id)) throw new Error('Unknown account')
    await keychainDelete(id)
    tokens.delete(id)
    usage.delete(id)
    state.accounts = state.accounts.filter(a => a.id !== id)
    save()
  }
  function rename(id: string, rawLabel: unknown) {
    const label = cleanLabel(rawLabel)
    if (!label) throw new Error('Give the account a name.')
    if (id === 'login') state.loginLabel = label
    else {
      const a = state.accounts.find(x => x.id === id)
      if (!a) throw new Error('Unknown account')
      a.label = label
    }
    save()
  }
  function setMode(mode: unknown) {
    state.mode = mode === 'auto' ? 'auto' : 'manual'
    save()
  }
  // A reset passing by changes what the menu shows and where new tabs start.
  setInterval(() => { if (Object.values(state.exhausted).some(until => !(until > Date.now()))) save() }, 30_000)

  return { listing, forTab, use, add, openInChrome, cancel, remove, rename, setMode }
}
