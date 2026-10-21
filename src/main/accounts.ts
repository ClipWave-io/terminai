import { execFile, execFileSync, spawn } from 'node:child_process'
import { createHash, randomUUID, X509Certificate } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'
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
 * Claude Code in a TerminAI tab reaches Anthropic through the relay below, as its HTTPS proxy with
 * the tab's workspace key as the proxy user name (see proxyEnv in pty-recovered.js). The relay
 * forwards its requests to Anthropic unchanged, except that it signs /v1/messages with the account
 * picked for the tab: switching account takes effect on the next request, with nothing restarted.
 * The saved login stays Claude Code's credential for everything else, so connectors and Remote
 * Control keep working, on the login account. Not ANTHROPIC_BASE_URL: any base URL other than
 * api.anthropic.com turns Remote Control off (code.claude.com/docs/en/remote-control#requirements).
 */
export const KEYCHAIN_SERVICE = 'TerminAI Claude account'
const SECURITY = '/usr/bin/security'
// Tests point the relay at a fake Anthropic.
const UPSTREAM = new URL(process.env.TERMINAI_RELAY_UPSTREAM || 'https://api.anthropic.com')
const TOKEN = /sk-ant-oat01-[A-Za-z0-9_-]{20,}(?=[^A-Za-z0-9_-])/
const FLOW_TIMEOUT_MS = 10 * 60_000
const API_HOST = 'api.anthropic.com'
// The program whose connections the relay opens: Claude Code's native binary runs as `claude`.
// Tests name another one.
const CLIENT = process.env.TERMINAI_RELAY_CLIENT || 'claude'
// What statusline.sh keeps of /api/oauth/usage for the login account, refreshed every 5 minutes.
const LOGIN_USAGE_FILE = process.env.TERMINAI_LOGIN_USAGE_FILE || join(homedir(), '.claude', 'cache', 'usage-limits.json')
const USAGE_STALE_MS = 5 * 60_000
// The smallest request Anthropic answers with a plan's usage: a subscription token is only good for
// requests that present themselves as Claude Code.
const PROBE = JSON.stringify({ model: 'claude-haiku-5-5', max_tokens: 1, system: "You are Claude Code, Anthropic's official CLI for Claude.", messages: [{ role: 'user', content: '.' }] })

type Usage = NonNullable<ClaudeAccount['usage']>
interface Saved { id: string; label: string; fp: string; addedAt: number }
interface State { mode: 'manual' | 'auto'; loginLabel?: string; defaultId?: string; accounts: Saved[]; exhausted: Record<string, number>; usage: Record<string, Usage> }

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
        defaultId: typeof j.defaultId === 'string' ? j.defaultId : undefined,
        accounts: Array.isArray(j.accounts) ? j.accounts.filter((a: any) => validId(a?.id) && cleanLabel(a.label)) : [],
        exhausted: j.exhausted && typeof j.exhausted === 'object' ? j.exhausted : {},
        usage: j.usage && typeof j.usage === 'object' ? j.usage : {},
      }
    } catch {
      return { mode: 'manual', accounts: [], exhausted: {}, usage: {} }
    }
  }
  const state = load()

  const ids = () => ['login', ...state.accounts.map(a => a.id)]
  const usable = (id: string) => !(state.exhausted[id] > Date.now())
  const labelOf = (id: string) => id === 'login' ? state.loginLabel || loginName() : state.accounts.find(a => a.id === id)?.label ?? ''
  // New tabs start on the account picked as the default, the login until one is; in automatic mode, on
  // the first one from there in menu order with usage left.
  const chosenDefault = () => state.defaultId && ids().includes(state.defaultId) ? state.defaultId : 'login'
  const defaultAccount = () => {
    const chosen = chosenDefault()
    return state.mode === 'auto' && !usable(chosen) ? nextUsable(chosen) || chosen : chosen
  }
  const save = () => {
    const now = Date.now()
    for (const [id, until] of Object.entries(state.exhausted)) if (!(until > now) || !ids().includes(id)) delete state.exhausted[id]
    for (const id of Object.keys(state.usage)) if (!ids().includes(id)) delete state.usage[id]
    if (state.defaultId && !ids().includes(state.defaultId)) delete state.defaultId
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

  function listing(): ClaudeAccounts {
    const now = Date.now()
    return {
      mode: state.mode,
      defaultId: chosenDefault(),
      accounts: ids().map(id => {
        const u = state.usage[id]
        // A window that has reset since the last answer starts again from zero.
        const usage = u && { ...u, fiveHour: u.fiveReset && u.fiveReset <= now ? 0 : u.fiveHour, week: u.weekReset && u.weekReset <= now ? 0 : u.week }
        return { id, label: labelOf(id), login: id === 'login', exhaustedUntil: state.exhausted[id] > now ? state.exhausted[id] : 0, usage }
      }),
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
  /** The plan's usage as Anthropic reports it on every answer; false when the answer carries none. */
  function noteUsage(id: string, h: http.IncomingHttpHeaders): boolean {
    if (!h['anthropic-ratelimit-unified-status']) return false
    const at = (k: string) => (limitHeader(h, k) || 0) * 1000
    state.usage[id] = { fiveHour: limitHeader(h, '5h-utilization') || 0, fiveReset: at('5h-reset'), week: limitHeader(h, '7d-utilization') || 0, weekReset: at('7d-reset'), at: Date.now() }
    return true
  }
  /** A plan or spend limit, as opposed to a passing throttle that Claude Code retries by itself. */
  function noteLimit(id: string, status: number, h: http.IncomingHttpHeaders): boolean {
    if (status !== 429 || h['anthropic-ratelimit-unified-status'] !== 'rejected') return false
    const reset = limitHeader(h, 'reset')
    state.exhausted[id] = reset > 0 ? reset * 1000 : Date.now() + 5 * 3600_000
    return true
  }
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
    // Only model requests made with the login are signed with the tab's account: the rest, and anything
    // launched with an API key of its own, go through exactly as they came.
    const model = path.startsWith('/v1/messages') && /^Bearer sk-ant-oat/.test(String(req.headers.authorization)) && !req.headers['x-api-key']
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
      if (model && noteLimit(id, status, r.headers)) {
        save()
        const next = state.mode === 'auto' ? nextUsable(id) : ''
        if (next && !tried.has(next)) {
          r.resume()
          setKey(key, next)
          continue
        }
      }
      if (model && status < 400 && noteUsage(id, r.headers)) save()
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
  // Loopback only. New tabs are routed here only while this file exists (and names the CA), so a
  // relay that failed to start leaves them on a direct connection.
  relay.listen(0, '127.0.0.1', () => {
    const address = relay.address()
    if (address && typeof address === 'object') writeFileSync(relayUrlFile, `http://127.0.0.1:${address.port}${cert ? `\n${cert.ca}` : ''}`)
  })

  // ---- the HTTPS proxy ------------------------------------------------------------
  // A certificate for api.anthropic.com from a CA of our own that may sign nothing else (name
  // constraint), trusted by the tabs through NODE_EXTRA_CA_CERTS. The CA key is deleted once the
  // certificate is signed; both are made again when it nears its end.
  const tlsDir = join(root, 'tls')
  const cert = (() => {
    const pem = join(tlsDir, 'cert.pem'), key = join(tlsDir, 'key.pem'), ca = join(tlsDir, 'ca.pem')
    try {
      const c = { cert: readFileSync(pem), key: readFileSync(key), ca }
      if (Date.parse(new X509Certificate(c.cert).validTo) - Date.now() > 30 * 86400_000) return c
    } catch {}
    try {
      rmSync(tlsDir, { recursive: true, force: true })
      mkdirSync(tlsDir, { recursive: true, mode: 0o700 })
      const at = (f: string) => join(tlsDir, f), ssl = (...a: string[]) => execFileSync('/usr/bin/openssl', a, { cwd: tlsDir, stdio: 'ignore', timeout: 20_000 })
      writeFileSync(at('ca.cnf'), `[req]\ndistinguished_name=dn\nx509_extensions=v3\nprompt=no\n[dn]\nCN=TerminAI local relay\n[v3]\nbasicConstraints=critical,CA:TRUE,pathlen:0\nkeyUsage=critical,keyCertSign,cRLSign\nnameConstraints=critical,permitted;DNS:${API_HOST}\nsubjectKeyIdentifier=hash\n`)
      writeFileSync(at('cert.ext'), `basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:${API_HOST}\nauthorityKeyIdentifier=keyid\n`)
      ssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '900', '-config', 'ca.cnf')
      ssl('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'key.pem', '-out', 'cert.csr', '-subj', `/CN=${API_HOST}`)
      ssl('x509', '-req', '-in', 'cert.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'cert.pem', '-days', '825', '-extfile', 'cert.ext')
      for (const f of ['ca.key', 'ca.srl', 'ca.cnf', 'cert.csr', 'cert.ext']) rmSync(at(f), { force: true })
      return { cert: readFileSync(pem), key: readFileSync(key), ca }
    } catch (err) {
      console.error('[accounts] no certificate for the proxy, tabs connect directly:', err)
      return null
    }
  })()
  /** Whether the loopback connection from this port was opened by Claude Code itself. */
  const clientCache = new Map<number, boolean>()
  setInterval(() => clientCache.clear(), 10 * 60_000).unref()
  function fromClaude(port: number): Promise<boolean> {
    return new Promise(resolve => execFile('/usr/sbin/lsof', ['-nP', `-iTCP@127.0.0.1:${port}`, '-sTCP:ESTABLISHED', '-Fp'], { timeout: 5_000 }, (_e, out) => {
      const pids = [...new Set(String(out).split('\n').filter(l => l.startsWith('p')).map(l => Number(l.slice(1))))].filter(p => p !== process.pid)
      if (pids.length !== 1) { resolve(false); return }
      if (clientCache.has(pids[0])) { resolve(clientCache.get(pids[0])!); return }
      execFile('/bin/ps', ['-o', 'comm=', '-p', String(pids[0])], { timeout: 5_000 }, (_e2, comm) => {
        const is = String(comm).trim().split('/').pop() === CLIENT
        clientCache.set(pids[0], is)
        resolve(is)
      })
    }))
  }
  // Requests on a connection opened below: the same forward() as the relay's, keyed by the tab.
  const opened = http.createServer((req, res) => {
    const key = (req.socket as tls.TLSSocket & { tabKey?: string }).tabKey ?? ''
    const chunks: Buffer[] = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => {
      forward(key, req.url || '/', req, res, Buffer.concat(chunks)).catch(err => {
        if (res.headersSent) { res.destroy(); return }
        res.writeHead(502, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: `TerminAI relay: ${String(err?.message || err)}` } }))
      })
    })
  })
  opened.on('upgrade', (req, sock, head) => {
    const plain = UPSTREAM.protocol === 'http:', port = Number(UPSTREAM.port) || (plain ? 80 : 443)
    const up = plain ? net.connect(port, UPSTREAM.hostname) : tls.connect({ host: UPSTREAM.hostname, port, servername: UPSTREAM.hostname })
    up.once(plain ? 'connect' : 'secureConnect', () => {
      up.write(`${req.method} ${req.url} HTTP/1.1\r\n${req.rawHeaders.map((v, i) => i % 2 ? `${v}\r\n` : `${v}: `).join('')}\r\n`)
      up.write(head); up.pipe(sock); sock.pipe(up)
    })
    up.on('error', () => sock.destroy()); sock.on('error', () => up.destroy())
  })
  // Claude Code's connections to api.anthropic.com are opened here; any other program in the tab, and
  // any other host, gets a plain tunnel and its own end-to-end TLS.
  relay.on('connect', (req: http.IncomingMessage, sock: net.Socket, head: Buffer) => {
    const [host, portText] = String(req.url).split(':'), port = Number(portText) || 443
    const auth = String(req.headers['proxy-authorization'] || '').replace(/^Basic /i, '')
    const key = Buffer.from(auth, 'base64').toString().split(':')[0]
    sock.on('error', () => sock.destroy())
    void (cert && host === API_HOST && port === 443 && validKey(key) ? fromClaude(sock.remotePort ?? 0) : Promise.resolve(false)).then(open => {
      if (sock.destroyed) return
      if (open && cert) {
        sock.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        if (head.length) sock.unshift(head)
        const t = Object.assign(new tls.TLSSocket(sock, { isServer: true, cert: cert.cert, key: cert.key, ALPNProtocols: ['http/1.1'] }), { tabKey: key })
        t.on('error', () => t.destroy())
        opened.emit('connection', t)
        return
      }
      const up = net.connect(port, host, () => {
        sock.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        if (head.length) up.write(head)
        up.pipe(sock); sock.pipe(up)
      })
      up.on('error', () => { if (!sock.destroyed) sock.end('HTTP/1.1 502 Bad Gateway\r\n\r\n') })
      sock.on('close', () => up.destroy())
    })
  })

  // ---- every plan's usage, for the menu -----------------------------------------
  const probing = new Set<string>()
  function probe(id: string, token: string): Promise<void> {
    return new Promise(resolve => {
      const up = client.request({ protocol: UPSTREAM.protocol, hostname: UPSTREAM.hostname, port: UPSTREAM.port, path: '/v1/messages?beta=true', method: 'POST', agent, timeout: 20_000,
        headers: { authorization: `Bearer ${token}`, 'anthropic-version': '2023-06-01', 'anthropic-beta': 'oauth-2025-04-20', 'content-type': 'application/json' } }, r => {
        r.resume()
        if (noteLimit(id, r.statusCode ?? 0, r.headers) || noteUsage(id, r.headers)) save()
        resolve()
      })
      up.on('error', () => resolve())
      up.on('timeout', () => up.destroy())
      up.end(PROBE)
    })
  }
  /** Fresh numbers for accounts not seen for a while: the login's from statusline.sh's cache, the others asked for. */
  async function refreshUsage() {
    const stale = (id: string) => !(Date.now() - (state.usage[id]?.at ?? 0) < USAGE_STALE_MS) && !probing.has(id)
    if (stale('login')) {
      try {
        const at = statSync(LOGIN_USAGE_FILE).mtimeMs
        const limits: any[] = JSON.parse(readFileSync(LOGIN_USAGE_FILE, 'utf8')).limits ?? []
        const kind = (k: string) => limits.find(l => l.kind === k)
        const session = kind('session'), weekly = kind('weekly_all')
        if (session && weekly && at > (state.usage.login?.at ?? 0)) {
          state.usage.login = { fiveHour: session.percent / 100, fiveReset: Date.parse(session.resets_at) || 0, week: weekly.percent / 100, weekReset: Date.parse(weekly.resets_at) || 0, at }
          save()
        }
      } catch {}
    }
    await Promise.all(state.accounts.filter(a => stale(a.id)).map(async a => {
      probing.add(a.id)
      try { const token = await tokenOf(a.id); if (token) await probe(a.id, token) } finally { probing.delete(a.id) }
    }))
  }

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
  /** Where new tabs start. A tab already open that never picked an account keeps the one it is on. */
  function setDefault(id: string) {
    if (!ids().includes(id)) throw new Error('Unknown account')
    for (const ptyId of ptys.liveIds()) {
      const key = ptys.workspaceKeyOf(ptyId)
      if (validKey(key)) try { readFileSync(join(tabsDir, key)) } catch { writeFileSync(join(tabsDir, key), accountOfKey(key)) }
    }
    state.defaultId = id
    save()
  }
  function setMode(mode: unknown) {
    state.mode = mode === 'auto' ? 'auto' : 'manual'
    save()
  }
  // A reset passing by changes what the menu shows and where new tabs start.
  setInterval(() => { if (Object.values(state.exhausted).some(until => !(until > Date.now()))) save() }, 30_000)

  return { listing, forTab, use, add, openInChrome, cancel, remove, rename, setDefault, setMode, refreshUsage }
}
