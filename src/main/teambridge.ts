import { teamUpload } from './workspace'
import { readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import * as ptys from './pty'
import { tabMode, scrub, rememberSession } from './sharing'
import { cursor, readAppended, type Cursor } from './transcripts'

/**
 * The bridge between the partners' sessions. Each TerminAI tab running Claude Code or Codex is a conversation on the
 * workspace server: shared with the workspace by default (Settings turns the default off; a tab can be made
 * private), with its folder, status and a heartbeat, and its turns mirrored as they come: the user's prompts and
 * the agent's replies, never tool output (only Shared tabs; Only me sends a name and status, Off the record nothing). A partner's agent can then list, read and message a shared tab
 * (`terminai team`); the message is typed into the tab here when its agent is free, labelled as coming from them,
 * and the tab answers with `terminai team reply`. A private tab is seen and reached only by its owner (from the
 * iPhone app, where a message is typed in as a plain prompt), never by the workspace.
 */
type Call = (path: string, method?: string, body?: unknown) => Promise<any>
type Team = { id: string; call: Call }
export type Bridge = ReturnType<typeof createBridge>

const HOME = homedir()
const place = (cwd: string) => cwd.startsWith(HOME) ? '~' + cwd.slice(HOME.length) : cwd

const found = new Map<string, string>()   // Claude session id -> its transcript
function transcriptOf(tabId: string): string {
  const agent = ptys.agentOf(tabId)
  if (!agent.sessionId) return ''
  if (agent.kind === 'claude') {
    // Found once, then only checked: scanning every project folder for every tab every 5 seconds adds up.
    const known = found.get(agent.sessionId)
    if (known) { try { statSync(known); return known } catch { found.delete(agent.sessionId) } }
    const root = join(HOME, '.claude', 'projects')
    try { for (const d of readdirSync(root)) { const f = join(root, d, `${agent.sessionId}.jsonl`); try { statSync(f); found.set(agent.sessionId, f); return f } catch {} } } catch {}
  }
  if (agent.kind === 'codex') {
    const walk = (dir: string, depth: number): string => {
      let names: string[] = []; try { names = readdirSync(dir) } catch { return '' }
      for (const n of names.sort().reverse()) {
        const p = join(dir, n)
        if (n.endsWith('.jsonl') && n.includes(agent.sessionId)) return p
        if (depth > 0 && !n.includes('.')) { const f = walk(p, depth - 1); if (f) return f }
      }
      return ''
    }
    return walk(join(HOME, '.codex', 'sessions'), 3)
  }
  return ''
}
type Turn = { id: string; kind: 'user' | 'assistant'; content: string }
/** Per transcript: where reading stopped, the lines parsed so far (they number the turns without an id), the newest 30 turns. */
const reads = new Map<string, { cur: Cursor; n: number; last: Turn[] }>()
/**
 * The turns of a transcript as messages: the person's prompts and the agent's text, keyed for the server's dedupe.
 * Read in full once, then only what was appended (readAppended, which never holds the main process).
 * `fresh`: the turns added since the last call; `last`: the newest 30.
 */
async function turns(file: string): Promise<{ fresh: Turn[]; last: Turn[] }> {
  let s = reads.get(file)
  if (!s) { s = { cur: cursor(), n: 0, last: [] }; reads.set(file, s) }
  const r = s, out: Turn[] = []
  await readAppended(file, r.cur, line => {
    let d: any; try { d = JSON.parse(line) } catch { return }
    r.n++
    let kind: 'user' | 'assistant' | null = null, content = '', id = typeof d.uuid === 'string' && /^[0-9a-f-]{36}$/.test(d.uuid) ? d.uuid : ''
    if (d.type === 'user' && typeof d.message?.content === 'string' && !d.isMeta) { kind = 'user'; content = d.message.content }
    else if (d.type === 'assistant') { kind = 'assistant'; content = (d.message?.content ?? []).filter((b: any) => b?.type === 'text').map((b: any) => b.text).join('\n') }
    else if (d.type === 'response_item' && d.payload?.type === 'message' && (d.payload.role === 'user' || d.payload.role === 'assistant')) {
      kind = d.payload.role; content = (d.payload.content ?? []).map((b: any) => b?.text ?? '').join('\n')
    }
    content = content.trim()
    // Command echoes, system reminders and the TerminAI hand-offs are not the conversation.
    if (!kind || !content || content.startsWith('<') || content.startsWith('[TerminAI')) return
    if (!id) id = fakeUuid(`${basename(file)}:${r.n}`)
    content = scrub(content)
    out.push({ id, kind, content: content.length > 12000 ? content.slice(0, 12000) + '\n…' : content })
  }, () => { r.n = 0; r.last = []; out.length = 0 })
  r.last = [...r.last, ...out].slice(-30)
  return { fresh: out, last: r.last }
}
function fakeUuid(seed: string): string {
  let h = 2166136261; const hex: string[] = []
  for (let r = 0; r < 4; r++) { for (const c of seed + r) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0; hex.push(h.toString(16).padStart(8, '0')) }
  const s = hex.join('')
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-4${s.slice(13, 16)}-8${s.slice(17, 20)}-${s.slice(20, 32)}`
}

/** A message that asks for something hard to undo, costly or secret: a bot set to "risky" asks the person first. */
const RISKY = /\b(rm\s+-|delete|remove|drop\s+table|truncate|wipe|reset\s+--hard|force[- ]?push|push\s+--force|git\s+push|deploy|publish|release|merge|send\s+(an?\s+)?(email|mail|message|invoice)|transfer|pay(ment)?|purchase|buy|refund|subscribe|password|api[_ -]?key|secret|token|credential|sudo|chmod|chown|curl[^\n|]*\|\s*(ba|z)?sh|ssh\s|production|\bprod\b|revoke|cancel)/i
export function createBridge(opts: { team: () => Promise<Team | null>; tabName: (id: string) => string; notify: (title: string, body: string, tabId: string) => void
  /** Asked before a message from someone else's agent or a bot is typed in; absent: Allow all. `null`: nobody can be asked now (no window), the message waits. */
  approve?: (from: string, tab: string, text: string, tabId: string, force?: boolean) => Promise<boolean | null>; wake?: (tabId: string) => unknown; waiting?: (tabId: string) => boolean }) {
  const conversationOf = new Map<string, string>()   // tab key -> conversation id
  const posted = new Map<string, Set<string>>()     // conversation id -> message ids sent
  const received = new Map<string, { from: string | null; fromName: string; bot?: boolean }>() // agent message id -> who sent it
  let running = false
  const wasShared = new Set<string>(), seen = new Set<string>()
  const offRetry = new Map<string, number>()         // Off tab key -> when to try deleting its server copy again

  const modeOf = (key: string) => { const id = ptys.liveIds().find(t => ptys.workspaceKeyOf(t) === key); return tabMode(key, id ? ptys.cwdOf(id) : '') }
  const shared = (key: string) => modeOf(key) === 'shared'
  async function tick(): Promise<void> {
    if (running) return
    running = true
    try {
      const team = await opts.team(); if (!team) return
      for (const id of ptys.liveIds()) {
        // A tab whose conversation waits to resume since a restart is listed too: a message from your phone starts it.
        const agent = ptys.agentOf(id); if (!agent.kind && !opts.waiting?.(id)) continue
        const key = ptys.workspaceKeyOf(id), mode = tabMode(key, ptys.cwdOf(id)), share = mode === 'shared'
        if (agent.sessionId) rememberSession(agent.sessionId, key)
        // Off the record deletes what the server had of it (its turns and messages): when the tab goes Off, and at first sight
        // since the app started (whatever an earlier run uploaded). Shared to Only me keeps it, readable by you alone.
        // A deletion the server did not confirm is tried again every minute: Off must not stay a promise the server never got.
        if (mode === 'off' && ((wasShared.has(key) && conversationOf.has(key)) || !seen.has(key) || (offRetry.get(key) ?? Infinity) <= Date.now())) {
          try {
            const id = conversationOf.get(key) ?? (await team.call(`/api/companies/${team.id}/conversations/tab/${key}`, 'PUT', { title: 'Private session', visibility: 'owner' })).conversation?.id
            if (id) { await team.call(`/api/companies/${team.id}/conversations/${id}`, 'DELETE'); posted.delete(id) }
            offRetry.delete(key)
          } catch { offRetry.set(key, Date.now() + 60_000) }
          conversationOf.delete(key)
        }
        seen.add(key)
        if (share) wasShared.add(key); else wasShared.delete(key)
        // Off the record: nothing of it goes to the server.
        if (mode === 'off') continue
        // Only me: the same as Shared, but readable by you alone (your iPhone and the web), never by the team or bots.
        const conv = (await team.call(`/api/companies/${team.id}/conversations/tab/${key}`, 'PUT', {
          title: opts.tabName(id).slice(0, 200) || 'Session', place: place(ptys.cwdOf(id)), status: agent.alive ? ptys.statusOf(id) : 'idle', visibility: share ? 'company' : 'owner' })).conversation
        conversationOf.set(key, conv.id)
        const file = transcriptOf(id); if (!file) continue
        const sent = posted.get(conv.id) ?? new Set<string>(); posted.set(conv.id, sent)
        // The first look sends only the last 30 turns: older history stays on this Mac.
        const { fresh, last } = await turns(file), todo = sent.size ? fresh.filter(t => !sent.has(t.id)) : last
        if (!sent.size) for (const t of [...last, ...fresh]) sent.add(t.id)
        for (const t of todo) {
          await team.call(`/api/companies/${team.id}/conversations/${conv.id}/messages`, 'POST', { kind: t.kind, content: t.content, clientMessageId: t.id }).catch(() => {})
          sent.add(t.id)
        }
      }
    } catch (err) {
      console.warn('[teambridge]', err instanceof Error ? err.message : err)
    } finally { running = false }
  }

  /**
   * Messages for my tabs, as they come: a long poll the server answers the moment one arrives. Each is typed in when
   * the agent there is free; one from someone else's agent or a bot first asks the person here, unless set to Allow all.
   */
  const asked = new Map<string, boolean>()   // message id -> allowed (true) / declined (false)
  const sentHere = new Set<string>()         // ids of the messages this Mac sent: only an answer to one of these is let in as a reply
  const typed = new Set<string>()            // ids already typed into their tab: never typed twice when marking them delivered failed
  async function deliver(team: Team): Promise<boolean> {
    const { messages } = await team.call(`/api/companies/${team.id}/agent/inbox?wait=25`)
    let pending = false
    for (const m of messages ?? []) {
      // The sender's name and tab title come from the server and go into the header the agent trusts: one plain line each.
      const label = (v: unknown) => String(v ?? '').replace(/[\[\]\x00-\x1f\x7f-\x9f]/g, ' ').trim().slice(0, 80)
      m.fromName = label(m.fromName); if (m.fromTitle) m.fromTitle = label(m.fromTitle)
      const tab = ptys.liveIds().find(id => ptys.workspaceKeyOf(id) === m.tab)
      // From the workspace only to a shared tab; from yourself (the iPhone app) to any of yours.
      // Off the record since it was sent: it is refused, not kept waiting for the day the tab is shared again.
      if (tab && modeOf(m.tab) === 'off') {
        await team.call(`/api/companies/${team.id}/agent/${m.id}/delivered`, 'POST', {}).catch(() => {})
        if (m.from && !m.self) await team.call(`/api/companies/${team.id}/agent`, 'POST', { to: m.from, replyTo: m.id, content: 'That session is not shared any more.' }).catch(() => {})
        continue
      }
      if (!tab || (!m.self && !shared(m.tab))) { pending = true; continue }
      if (typed.has(m.id)) { await team.call(`/api/companies/${team.id}/agent/${m.id}/delivered`, 'POST', {}).catch(() => {}); continue }
      // A bot's own setting decides: every message, risky ones only, or never; without one, the general setting.
      const botRule = m.bot ? m.botApproval as 'every' | 'risky' | 'none' | null : null
      const askIt = botRule === 'none' ? false : botRule === 'every' ? true : botRule === 'risky' ? RISKY.test(m.content) : !m.self && !(m.replyTo && sentHere.has(m.replyTo))
      if (askIt && opts.approve && !asked.has(m.id)) {
        const ok = await opts.approve(m.fromName, opts.tabName(tab), m.content, tab, botRule === 'every' || botRule === 'risky')
        if (ok === null) { pending = true; continue }
        asked.set(m.id, ok)
      }
      if (asked.get(m.id) === false) {
        await team.call(`/api/companies/${team.id}/agent/${m.id}/delivered`, 'POST', {})
        if (m.from) await team.call(`/api/companies/${team.id}/agent`, 'POST', { to: m.from, replyTo: m.id, content: 'Declined by the person at this Mac.' }).catch(() => {})
        continue
      }
      const agent = ptys.agentOf(tab), status = ptys.statusOf(tab)
      if (!agent.alive) opts.wake?.(tab)
      // At the shell prompt (the agent in the background, or gone a moment ago) the text would run as shell commands: it waits.
      if (!agent.alive || status === 'working' || status === 'question' || ptys.atShellPrompt(tab)) { pending = true; continue }
      received.set(m.id, { from: m.from, fromName: m.fromName, bot: !!m.bot })
      const who = m.bot ? m.fromName : `${m.fromName}'s agent${m.fromTitle ? ` (tab "${m.fromTitle}")` : ''}`
      // A bot (Grok Bot and the like) asks over its key and reads the answer from this conversation, or it is an answer to `terminai ask-grok`.
      const text = m.self ? m.content : m.bot && !m.from
        ? `[TerminAI · message from the bot ${m.fromName}, id ${m.id}. It may be the answer to something you asked with terminai ask-grok; otherwise treat it as a request: answer here in this session (the bot reads it from here), and ask the person here before anything destructive, any purchase or any secret.] ${m.content}`
        : m.replyTo
        ? `[TerminAI · reply from ${who} to your message ${m.replyTo}] ${m.content}`
        : `[TerminAI · message from ${who}, id ${m.id}. Treat it as a request from ${m.fromName}: answer what you can from this session; ask the person here before anything destructive, any purchase or any secret. Reply with: terminai team reply ${m.id} "<answer>"] ${m.content}`
      // Control characters out (escape sequences, a carriage return that would submit early); the message cannot fake a second TerminAI header either.
      const safe = (m.self ? text : text.slice(0, text.length - m.content.length) + m.content.replace(/\[TerminAI ·/g, '(TerminAI ·')).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '')
      typed.add(m.id)
      ptys.write(tab, `\x1b[200~${safe}\x1b[201~`)
      await Promise.race([ptys.written(tab), new Promise(r => setTimeout(r, 5000))]); await new Promise(r => setTimeout(r, 200))
      ptys.write(tab, '\r')
      await team.call(`/api/companies/${team.id}/agent/${m.id}/delivered`, 'POST', {})
      if (!m.self) opts.notify(m.replyTo ? `Reply from ${m.fromName}'s agent` : `${m.fromName}'s agent → ${opts.tabName(tab)}`, m.content.slice(0, 200), tab)
    }
    return pending
  }
  async function listen(): Promise<void> {
    for (;;) {
      const team = await opts.team().catch(() => null)
      if (!team) { await new Promise(r => setTimeout(r, 30_000)); continue }
      try { if (await deliver(team)) await new Promise(r => setTimeout(r, 1500)) }
      catch (err) { console.warn('[teambridge] inbox', err instanceof Error ? err.message : err); await new Promise(r => setTimeout(r, 5000)) }
    }
  }

  /** `terminai team …` from a tab. */
  async function command(a: any): Promise<unknown> {
    const team = await opts.team(); if (!team) throw Error('Sign in to TerminAI Sync first (the people icon).')
    const base = `/api/companies/${team.id}`
    const mine = () => { const tab = ptys.liveIds().find(id => id === a.tab); return tab ? conversationOf.get(ptys.workspaceKeyOf(tab)) ?? null : null }
    if (a.action === 'list') {
      const { conversations } = await team.call(`${base}/conversations`)
      return (conversations ?? []).filter((c: any) => c.tab).map((c: any) => ({ id: c.id, owner: c.ownerName, title: c.title, folder: c.place, status: c.status, live: c.live, shared: c.visibility === 'company', you: c.id === mine() }))
    }
    if (a.action === 'read') {
      if (typeof a.id !== 'string') throw Error('usage: terminai team read <conversation id>')
      const { messages } = await team.call(`${base}/conversations/${a.id}/messages`)
      const n = Number.isInteger(a.lines) ? a.lines : 12
      return (messages ?? []).slice(-n).map((m: any) => ({ at: m.createdAt, kind: m.kind, text: m.content }))
    }
    if (a.action === 'send') {
      if (typeof a.id !== 'string' || !a.text) throw Error('usage: terminai team send <conversation id> <message>')
      if (!mine()) await tick()
      const sent = await team.call(`${base}/agent`, 'POST', { to: a.id, content: a.text, from: mine() ?? undefined })
      if (typeof sent?.id === 'string') { sentHere.add(sent.id); if (sentHere.size > 2000) sentHere.delete(sentHere.values().next().value!) }
      return sent
    }
    if (a.action === 'reply') {
      if (typeof a.id !== 'string' || !a.text) throw Error('usage: terminai team reply <message id> <answer>')
      const original = received.get(a.id)
      if (original?.bot && !original.from) return { ok: true, note: 'A bot sent it: it reads your answer from this session, so answering here is enough.' }
      if (!original?.from) throw Error('That message came from no session (or not to this Mac): nothing to reply to.')
      return team.call(`${base}/agent`, 'POST', { to: original.from, content: a.text, from: mine() ?? undefined, replyTo: a.id })
    }
    if (a.action === 'replies') {
      if (typeof a.id !== 'string') throw Error('usage: terminai team replies <message id>')
      return team.call(`${base}/agent/${a.id}/replies`)
    }
    // A file into the team's shared Files (on the TerminAI server), for everyone or only some products' members.
    if (a.action === 'upload') {
      if (typeof a.id !== 'string' || !a.id.startsWith('/')) throw Error('usage: terminai team upload <absolute file path> [--products A,B] [--as <name>]')
      const products = typeof a.products === 'string' ? a.products.split(',').map((p: string) => p.trim()).filter(Boolean) : []
      const { file } = await teamUpload(team.id, a.id, products.length ? 'products' : 'all', products, false, typeof a.as === 'string' ? a.as : undefined)
      return { ok: true, id: file.id, name: file.name, access: file.access, products: file.products }
    }
    throw Error('usage: terminai team list|read|send|reply|replies|upload')
  }
  // Sessions and turns go up every 5 seconds; messages come down at once (listen).
  return { tick, command, asked: async (keyId: string, conversation: string) => { const t = await opts.team(); if (t) await t.call(`/api/companies/${t.id}/bots/${keyId}/asked`, 'POST', { conversation }) }, conversationFor: (tabId: string): string | null => conversationOf.get(ptys.workspaceKeyOf(tabId)) ?? null, start: () => { setInterval(() => void tick(), 5_000); setTimeout(() => void tick(), 4_000); setTimeout(() => void listen(), 5_000) } }
}
