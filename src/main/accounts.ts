import { execFile, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import * as pty from '@homebridge/node-pty-prebuilt-multiarch'
import * as ptys from './pty'
import type { AccountFlow, ChromeProfile, ClaudeAccounts } from '../shared/types'

/**
 * The Claude Code accounts tabs can run on, so two tabs can sit on two plans and a tab whose plan
 * runs out can carry on with the next one. "login" is the sign-in `/login` saved on this Mac; every
 * other account is a one-year token from `claude setup-token`, kept in the login keychain under
 * KEYCHAIN_SERVICE and nowhere else: not in a file, not in the renderer, not in a log.
 *
 * The claude shim (pty-recovered.js) reads tabs/<workspace key>, or `default`, at every launch and
 * exports CLAUDE_CODE_OAUTH_TOKEN for that account. A plan running out is read from the session's
 * transcript, where Claude Code records the API error together with the time the limit resets.
 */
export const KEYCHAIN_SERVICE = 'TerminAI Claude account'
const SECURITY = '/usr/bin/security'
const TOKEN = /sk-ant-oat01-[A-Za-z0-9_-]{20,}(?=[^A-Za-z0-9_-])/
const FLOW_TIMEOUT_MS = 10 * 60_000
// What a tab moved by a usage limit is told once it is back, after Claude Code's own wording.
const CONTINUE = 'Your Claude usage limit was reached, so this session moved to another account. Continue the task you were working on when the limit was reached; do not repeat work that is already complete.'

interface Saved { id: string; label: string; fp: string; addedAt: number }
interface State { mode: 'manual' | 'auto'; loginLabel?: string; accounts: Saved[]; exhausted: Record<string, number> }

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const validId = (id: unknown): id is string => typeof id === 'string' && /^[0-9a-f-]{36}$/.test(id)
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

/** Token in on stdin, never on a command line another process could read. */
function keychainSave(id: string, label: string, token: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(SECURITY, ['-i'], { stdio: ['pipe', 'ignore', 'pipe'] })
    let err = ''
    p.stderr.on('data', d => { err += d })
    p.on('error', reject)
    p.on('exit', () => {
      // `security -i` exits 0 even when a command failed: read the item back to know.
      execFile(SECURITY, ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', id, '-w'], (e, out) => {
        if (!e && out.trim() === token) resolve()
        else reject(new Error(err.replace(TOKEN, '').trim() || 'The keychain did not keep the token.'))
      })
    })
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
  let state = load()

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
    writeFileSync(join(root, 'default'), defaultAccount())
    opts.changed()
  }
  save()

  const tabFile = (ptyId: string) => join(tabsDir, ptys.workspaceKeyOf(ptyId))
  function forTab(ptyId: string): string {
    try {
      const id = readFileSync(tabFile(ptyId), 'utf8').trim()
      if (ids().includes(id)) return id
    } catch {}
    return defaultAccount()
  }

  function listing(): ClaudeAccounts {
    const now = Date.now()
    return {
      mode: state.mode,
      accounts: ids().map(id => ({ id, label: labelOf(id), login: id === 'login', exhaustedUntil: state.exhausted[id] > now ? state.exhausted[id] : 0 })),
    }
  }

  // ---- moving a running tab to another account -----------------------------
  const switching = new Set<string>()
  /** Quit the claude in this tab and bring the same conversation back, now on the tab's account. */
  async function relaunch(ptyId: string, continueTask: boolean): Promise<boolean> {
    const agent = ptys.agentOf(ptyId)
    if (agent.kind !== 'claude' || !agent.alive || switching.has(ptyId)) return false
    switching.add(ptyId)
    try {
      const cmd = await ptys.launchCommandFor({ kind: 'claude', sessionId: agent.sessionId || ptys.claudeSessionOf(ptyId), args: agent.args, cwd: ptys.cwdOf(ptyId) })
      // Ctrl-C first ends a turn, a usage-limit wait or a menu; two in a row quit Claude Code.
      for (let i = 0; i < 12 && !ptys.atShellPrompt(ptyId); i++) {
        ptys.write(ptyId, '\x03')
        await sleep(450)
      }
      if (!ptys.atShellPrompt(ptyId)) return false
      await sleep(300)
      ptys.write(ptyId, `${cmd}\r`)
      if (continueTask) await continueWhenReady(ptyId)
      return true
    } finally {
      switching.delete(ptyId)
    }
  }
  async function continueWhenReady(ptyId: string) {
    const started = Date.now()
    // Claude is up and has stopped drawing: the resumed conversation is on screen, waiting.
    while (Date.now() - started < 90_000) {
      await sleep(1000)
      if (Date.now() - started < 4000 || ptys.atShellPrompt(ptyId)) continue
      if (ptys.statusOf(ptyId) !== 'waiting') continue
      ptys.write(ptyId, CONTINUE)
      // On its own, Enter submits; glued to the text a TUI takes it as part of the paste.
      await sleep(400)
      ptys.write(ptyId, '\r')
      return
    }
  }

  async function use(ptyId: string, id: string): Promise<boolean> {
    if (!ids().includes(id)) throw new Error('Unknown account')
    writeFileSync(tabFile(ptyId), id)
    opts.changed()
    return relaunch(ptyId, false)
  }

  // ---- a plan running out ----------------------------------------------------
  const projects = join(homedir(), '.claude', 'projects')
  const transcripts = new Map<string, string>()
  const offsets = new Map<string, number>()
  const partial = new Map<string, string>()
  function transcriptOf(sessionId: string): string {
    const known = transcripts.get(sessionId)
    if (known && existsSync(known)) return known
    try {
      for (const dir of readdirSync(projects)) {
        const path = join(projects, dir, `${sessionId}.jsonl`)
        if (existsSync(path)) { transcripts.set(sessionId, path); return path }
      }
    } catch {}
    return ''
  }
  /** Lines appended since the last look; on first sight the file's past is skipped. */
  function newLines(path: string): string[] {
    let size = 0
    try { size = statSync(path).size } catch { return [] }
    const from = offsets.get(path)
    offsets.set(path, size)
    if (from === undefined || size <= from) return []
    const buf = Buffer.alloc(Math.min(size - from, 8 << 20))
    const fd = openSync(path, 'r')
    try { readSync(fd, buf, 0, buf.length, size - buf.length) } finally { closeSync(fd) }
    const text = (partial.get(path) ?? '') + buf.toString('utf8')
    const lines = text.split('\n')
    partial.set(path, lines.pop() ?? '')
    return lines
  }
  /** When the limit resets, if this transcript line is Claude Code recording a plan that ran out. */
  function limitResetsAt(line: string): number {
    if (!line.includes('"isApiErrorMessage":true')) return 0
    try {
      const j = JSON.parse(line)
      const info = j.apiErrorParams?.rate_limit_info ?? j.quotaLimits
      if (j.apiError !== 'usage_limit_reached' && !(j.error === 'rate_limit' && info?.status === 'rejected')) return 0
      const at = Number(info?.resetsAt)
      return at > 0 ? at * 1000 : Date.now() + 5 * 3600_000
    } catch {
      return 0
    }
  }
  function limitReached(ptyId: string, until: number) {
    const id = forTab(ptyId)
    state.exhausted[id] = Math.max(state.exhausted[id] ?? 0, until)
    save()
    if (state.mode !== 'auto' || switching.has(ptyId)) return
    const order = ids(), at = order.indexOf(id)
    const next = [...order.slice(at + 1), ...order.slice(0, at)].find(usable)
    if (!next) return
    writeFileSync(tabFile(ptyId), next)
    opts.changed()
    void relaunch(ptyId, true)
  }
  function watch() {
    for (const ptyId of ptys.liveIds()) {
      const agent = ptys.agentOf(ptyId)
      if (agent.kind !== 'claude' || !agent.alive || !agent.sessionId) continue
      const path = transcriptOf(agent.sessionId)
      if (!path) continue
      for (const line of newLines(path)) {
        const until = limitResetsAt(line)
        if (until) limitReached(ptyId, until)
      }
    }
    // A reset passing by changes what the menu shows and where new tabs start.
    if (Object.values(state.exhausted).some(until => !(until > Date.now()))) save()
  }
  setInterval(watch, 3000)

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
  function cancel(flowId: string) {
    endFlow(flowId)
  }

  async function remove(id: string) {
    if (!validId(id) || !state.accounts.some(a => a.id === id)) throw new Error('Unknown account')
    await keychainDelete(id)
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

  return { listing, forTab, use, add, openInChrome, cancel, remove, rename, setMode }
}
