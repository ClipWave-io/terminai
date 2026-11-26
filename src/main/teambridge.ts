import { teamUpload, teamFiles, teamFetch, teamFileShare } from './workspace'
import { copyFile } from 'node:fs/promises'
import { join as joinPath, isAbsolute as absolute } from 'node:path'
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
const scanned = new Map<string, number>()
export function transcriptOf(tabId: string): string {
  const agent = ptys.agentOf(tabId)
  if (agent.kind === 'claude') {
    // The conversation running now: the id Claude Code reports for this tab, or the one it was started with. A resume in
    // another folder continues under a new id (a new transcript), so the start id alone left the Clean view and the
    // sharing on the old file. Of the two, the transcript written to last.
    const find = (id: string): string => {
      if (!id) return ''
      // A conversation moved to another folder keeps its id and goes on in a file under the new folder: of all the
      // files with this id, the one written to last. Looked up again every 30 s (scanning every project folder for
      // every tab every second would add up).
      const known = found.get(id)
      if (known && Date.now() - (scanned.get(id) ?? 0) < 30_000) { try { statSync(known); return known } catch { found.delete(id) } }
      const root = join(HOME, '.claude', 'projects')
      let best = '', at = 0
      try { for (const d of readdirSync(root)) { const f = join(root, d, `${id}.jsonl`); try { const m = statSync(f).mtimeMs; if (m > at) { at = m; best = f } } catch {} } } catch {}
      scanned.set(id, Date.now())
      if (best) found.set(id, best)
      return best
    }
    const files = [...new Set([ptys.claudeSessionOf(tabId), agent.sessionId])].map(find).filter(Boolean)
    const mtime = (f: string) => { try { return statSync(f).mtimeMs } catch { return 0 } }
    return files.sort((a, b) => mtime(b) - mtime(a))[0] ?? ''
  }
  if (!agent.sessionId) return ''
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
/** Share with… (saved with the tab): the organisation and the people who may read and message this one conversation. */
type Share = { company: string; companyName?: string; people: { id: string; name: string }[] }
/** A shared tab mirrored into an organisation other than the one picked in Sync gets a source key of its own there. */
const shareKey = (key: string, company: string) => `${key}-s${company.replace(/-/g, '').slice(0, 8)}`
const keyOfSource = (source: string) => source.replace(/-s[0-9a-f]{8}$/, '')
export function createBridge(opts: { team: () => Promise<Team | null>; tabName: (id: string) => string; paused?: (id: string) => boolean; notify: (title: string, body: string, tabId: string) => void
  shareOf?: (tabId: string) => Share | null
  /** Asked before a message from someone else's agent or a bot is typed in; absent: Allow all. `null`: nobody can be asked now (no window), the message waits. */
  approve?: (from: string, tab: string, text: string, tabId: string, force?: boolean, requests?: boolean) => Promise<boolean | 'side' | null>; wake?: (tabId: string) => unknown; waiting?: (tabId: string) => boolean
  /** "In a side conversation": a new conversation in a new tab, ready for the message; its id, or null. */
  side?: (tabId: string, from: string) => Promise<string | null>
  /**
   * The requests session for a teammate (their user id): one conversation per teammate that takes their requests, opened the
   * first time and reused (a fresh one each day). Its tab id once it is ready for a message; null while it opens.
   */
  requests?: (sender: string, name: string) => Promise<string | null>
  /** Messages from teammates' agents to one of my tabs go to their requests session too (Sync › Messages: Requests session). */
  toRequests?: () => boolean
  /** A requests session: it reaches Shared conversations only. */
  isRequests?: (tabId: string) => boolean
  /** That tab still waits for the answer to a `terminai ask`: no new request goes in yet. */
  asking?: (tabId: string) => boolean }) {
  const conversationOf = new Map<string, string>()   // tab key -> conversation id
  const posted = new Map<string, Set<string>>()     // conversation id -> message ids sent
  const received = new Map<string, { from: string | null; fromName: string; bot?: boolean; fromUser?: string | null; to?: string }>() // agent message id -> who sent it, to which of my conversations
  let running = false
  const wasShared = new Set<string>(), seen = new Set<string>(), wasOff = new Set<string>()
  const offRetry = new Map<string, number>()         // Off tab key -> when to try deleting its server copy again
  const shareConvOf = new Map<string, { company: string; conv: string }>() // tab key -> the conversation the people it is shared with read
  const sharedPeople = new Map<string, string>()     // that conversation id -> the people last sent to the server (ids, JSON)
  const shareCompanies = new Set<string>()           // organisations other than Sync's holding a shared tab: their inbox is listened to too
  const shareFor = (tabId: string): Share | null => { const v = opts.shareOf?.(tabId); return v && typeof v.company === 'string' && Array.isArray(v.people) && v.people.length ? v : null }
  /** Stop sharing (or Off): the conversation that was shared is shared with nobody; a copy kept only for the share is deleted. */
  async function unshare(team: Team, key: string, remove: boolean): Promise<void> {
    const was = shareConvOf.get(key); if (!was) return
    await team.call(`/api/companies/${was.company}/conversations/${was.conv}/share`, 'PUT', { people: [] })
    if (was.company !== team.id && remove) await team.call(`/api/companies/${was.company}/conversations/${was.conv}`, 'DELETE').catch(() => {})
    shareConvOf.delete(key); sharedPeople.delete(was.conv); posted.delete(was.conv)
  }

  const modeOf = (key: string) => { const id = ptys.liveIds().find(t => ptys.workspaceKeyOf(t) === key); return tabMode(key, id ? ptys.cwdOf(id) : '') }
  const shared = (key: string) => modeOf(key) === 'shared'
  async function tick(): Promise<void> {
    if (running) return
    running = true
    try {
      const team = await opts.team(); if (!team) return
      const companies = new Set<string>()
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
        // Off the record wins over Share with…: the people lose it, and a copy made for them is deleted (also one an earlier run made).
        if (mode === 'off' && shareConvOf.has(key)) await unshare(team, key, true).catch(() => {})
        const offShare = mode === 'off' && !wasOff.has(key) ? shareFor(id) : null
        if (mode === 'off') wasOff.add(key); else wasOff.delete(key)
        if (offShare && offShare.company !== team.id) {
          const c = offShare.company
          await team.call(`/api/companies/${c}/conversations/tab/${shareKey(key, c)}`, 'PUT', { title: 'Private session', visibility: 'owner' })
            .then(r => r.conversation?.id && team.call(`/api/companies/${c}/conversations/${r.conversation.id}`, 'DELETE')).catch(() => {})
        }
        // Off the record: nothing of it goes to the server.
        if (mode === 'off') continue
        // Only me: the same as Shared, but readable by you alone (your iPhone and the web), never by the team or bots.
        const info = { title: scrub(opts.tabName(id)).slice(0, 200) || 'Session', place: place(ptys.cwdOf(id)), status: opts.paused?.(id) ? 'paused' : agent.alive ? ptys.statusOf(id) : agent.kind ? 'not started' : 'idle' }
        const conv = (await team.call(`/api/companies/${team.id}/conversations/tab/${key}`, 'PUT', { ...info, visibility: share ? 'company' : 'owner' })).conversation
        conversationOf.set(key, conv.id)
        // Share with…: in the organisation picked in Sync it is this same conversation; in another one, a copy there that only
        // you and those people read (owner + shared with), its turns sent to both. Everything else stays in Sync's organisation.
        const sharing = shareFor(id)
        let shareConv: string | null = null
        if (sharing) {
          shareConv = sharing.company === team.id ? conv.id
            : (await team.call(`/api/companies/${sharing.company}/conversations/tab/${shareKey(key, sharing.company)}`, 'PUT', { ...info, visibility: 'owner' }).catch(err => { console.warn('[teambridge] share', err instanceof Error ? err.message : err); return null }))?.conversation?.id ?? null
          if (sharing.company !== team.id && shareConv) companies.add(sharing.company)
        }
        const was = shareConvOf.get(key)
        if (was && was.conv !== shareConv) await unshare(team, key, !sharing || was.company !== sharing.company).catch(() => {})
        if (sharing && shareConv) {
          shareConvOf.set(key, { company: sharing.company, conv: shareConv })
          const people = JSON.stringify(sharing.people.map(p => p.id).sort())
          if (sharedPeople.get(shareConv) !== people) {
            await team.call(`/api/companies/${sharing.company}/conversations/${shareConv}/share`, 'PUT', { people: JSON.parse(people) })
              .then(() => sharedPeople.set(shareConv!, people)).catch(err => console.warn('[teambridge] share', err instanceof Error ? err.message : err))
          }
        }
        const file = transcriptOf(id); if (!file) continue
        // The first look sends only the last 30 turns: older history stays on this Mac.
        const { fresh, last } = await turns(file)
        const targets: [string, string][] = [[team.id, conv.id], ...(sharing && shareConv && shareConv !== conv.id ? [[sharing.company, shareConv] as [string, string]] : [])]
        for (const [company, cid] of targets) {
          const sent = posted.get(cid) ?? new Set<string>(); posted.set(cid, sent)
          const todo = sent.size ? fresh.filter(t => !sent.has(t.id)) : last
          if (!sent.size) for (const t of [...last, ...fresh]) sent.add(t.id)
          for (const t of todo) {
            await team.call(`/api/companies/${company}/conversations/${cid}/messages`, 'POST', { kind: t.kind, content: t.content, clientMessageId: t.id }).catch(() => {})
            sent.add(t.id)
          }
        }
      }
      // The inbox of each organisation a tab is shared into: the people's agents' messages reach the tab from there.
      for (const c of [...shareCompanies]) if (!companies.has(c)) shareCompanies.delete(c)
      for (const c of companies) { shareCompanies.add(c); listenTo(c) }
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
  const sideOf = new Map<string, string>()   // message id -> the side-conversation tab it goes to instead
  const typed = new Set<string>()            // ids already typed into their tab: never typed twice when marking them delivered failed
  // A requests session takes one request at a time: after one is typed in, the next waits until that turn has ended
  // (seen working, then waiting for a few seconds) and no question it asked with `terminai ask` is still open.
  const turnOpen = new Set<string>()
  function watchTurn(tab: string): void {
    turnOpen.add(tab)
    const t0 = Date.now(); let worked = false, quiet = 0
    const step = () => {
      const st = ptys.liveIds().includes(tab) ? ptys.statusOf(tab) : 'exited'
      if (st === 'exited' || Date.now() - t0 > 3 * 3600_000) { turnOpen.delete(tab); return }
      if (st === 'working') { worked = true; quiet = 0 }
      else if (st === 'waiting' && (worked || Date.now() - t0 > 20_000) && !opts.asking?.(tab)) { if (++quiet >= 3) { turnOpen.delete(tab); return } }
      else quiet = 0
      setTimeout(step, 1000)
    }
    setTimeout(step, 1500)
  }
  /** `main`: the organisation picked in Sync (its Shared tabs take the workspace's messages); otherwise one a tab is shared into. */
  async function deliver(team: Team, main = true): Promise<boolean> {
    const { messages } = await team.call(`/api/companies/${team.id}/agent/inbox?wait=25`)
    let pending = false
    const held = new Set<string>()           // requests sessions with an earlier message still waiting: the later ones keep their turn
    for (const m of messages ?? []) {
      // The sender's name and tab title come from the server and go into the header the agent trusts: one plain line each.
      const label = (v: unknown) => String(v ?? '').replace(/[\[\]\x00-\x1f\x7f-\x9f]/g, ' ').trim().slice(0, 80)
      m.fromName = label(m.fromName); if (m.fromTitle) m.fromTitle = label(m.fromTitle)
      // Sent to a person (terminai team send --to): held in the mailbox "requests-<workspace>-<sender>", never a tab of mine.
      const forPerson = typeof m.tab === 'string' && m.tab.startsWith('requests-')
      // A conversation shared into another organisation (Share with…) has its own source key there: the tab's key plus a suffix.
      if (!forPerson && typeof m.tab === 'string') m.tab = keyOfSource(m.tab)
      const own = forPerson ? undefined : ptys.liveIds().find(id => ptys.workspaceKeyOf(id) === m.tab)
      // From the workspace only to a shared tab; from yourself (the iPhone app) to any of yours.
      // Off the record since it was sent: it is refused, not kept waiting for the day the tab is shared again.
      if (own && modeOf(m.tab) === 'off') {
        await team.call(`/api/companies/${team.id}/agent/${m.id}/delivered`, 'POST', {}).catch(() => {})
        if (m.from && !m.self) await team.call(`/api/companies/${team.id}/agent`, 'POST', { to: m.from, replyTo: m.id, content: 'That session is not shared any more.' }).catch(() => {})
        continue
      }
      // Let in: from yourself; to a Shared tab (Sync's organisation only); to a tab shared with people of this organisation (only
      // they can reach it, the server checks); or an answer to a message this Mac sent.
      const sharedHere = !!own && shareFor(own)?.company === team.id
      if (!forPerson && (!own || (!m.self && !(main && shared(m.tab)) && !sharedHere && !(m.replyTo && sentHere.has(m.replyTo))))) { pending = true; continue }
      if (forPerson && !main) { pending = true; continue }
      if (typed.has(m.id)) { await team.call(`/api/companies/${team.id}/agent/${m.id}/delivered`, 'POST', {}).catch(() => {}); continue }
      const answer = !!(m.replyTo && sentHere.has(m.replyTo))
      // A teammate's agent (never a bot, never yourself): to their requests session, which cannot interrupt anything. Always for a
      // message sent to the person; for one sent to a tab of mine when Sync › Messages is set to Requests session. An answer to a
      // message this Mac sent goes to the tab that asked.
      const viaRequests = !!opts.requests && typeof m.fromUser === 'string' && !m.self && !m.bot
        && (forPerson || (!answer && !!opts.toRequests?.() && !!own && !opts.isRequests?.(own)))
      let tab: string | undefined = own
      if (viaRequests) {
        if (held.has(`u:${m.fromUser}`)) { pending = true; continue }
        const r = await opts.requests!(m.fromUser, m.fromName).catch(() => null)
        if (!r || turnOpen.has(r) || opts.asking?.(r)) { held.add(`u:${m.fromUser}`); pending = true; continue }
        tab = r
      } else if (forPerson) { pending = true; continue }
      else { const side = sideOf.get(m.id); if (side && ptys.liveIds().includes(side)) tab = side }
      if (!tab) { pending = true; continue }
      const wait = () => { pending = true; if (viaRequests) held.add(`u:${m.fromUser}`) }
      // A bot's own setting decides: every message, risky ones only, or never; without one, the general setting.
      // Into a requests session: no question, except for a message asking something risky.
      const botRule = m.bot ? m.botApproval as 'every' | 'risky' | 'none' | null : null
      const askIt = viaRequests ? RISKY.test(m.content) : botRule === 'none' ? false : botRule === 'every' ? true : botRule === 'risky' ? RISKY.test(m.content) : !m.self && !answer
      if (askIt && opts.approve && !asked.has(m.id)) {
        const ok = await opts.approve(m.fromName, opts.tabName(tab), m.content, tab, botRule === 'every' || botRule === 'risky', viaRequests)
        if (ok === null) { wait(); continue }
        if (ok === 'side' && viaRequests) asked.set(m.id, true)
        else if (ok === 'side') {
          const fork = await opts.side?.(tab, m.fromName).catch(() => null)
          if (fork) sideOf.set(m.id, fork)
          asked.set(m.id, true); pending = true; continue
        }
        else asked.set(m.id, ok)
      }
      if (asked.get(m.id) === false) {
        await team.call(`/api/companies/${team.id}/agent/${m.id}/delivered`, 'POST', {})
        if (m.from) await team.call(`/api/companies/${team.id}/agent`, 'POST', { to: m.from, replyTo: m.id, content: 'Declined by the person at this Mac.' }).catch(() => {})
        continue
      }
      const agent = ptys.agentOf(tab), status = ptys.statusOf(tab)
      if (!agent.alive) opts.wake?.(tab)
      // At the shell prompt (the agent in the background, or gone a moment ago) the text would run as shell commands: it waits.
      if (!agent.alive || status === 'working' || status === 'question' || ptys.atShellPrompt(tab)) { wait(); continue }
      received.set(m.id, { from: m.from, fromName: m.fromName, bot: !!m.bot, fromUser: m.fromUser ?? null, to: m.to })
      const who = m.bot ? m.fromName : `${m.fromName}'s agent${m.fromTitle ? ` (tab "${m.fromTitle}")` : ''}`
      // A bot (Grok Bot and the like) asks over its key and reads the answer from this conversation, or it is an answer to `terminai ask-grok`.
      const text = m.self ? m.content : m.bot && !m.from
        ? `[TerminAI · message from the bot ${m.fromName}, id ${m.id}. It may be the answer to something you asked with terminai ask-grok; otherwise treat it as a request: answer here in this session (the bot reads it from here), and ask the person here before anything destructive, any purchase or any secret.] ${m.content}`
        : m.replyTo
        ? `[TerminAI · reply from ${who} to your message ${m.replyTo}] ${m.content}`
        : viaRequests
        ? `[TerminAI · request from ${who}, id ${m.id}${own ? `, sent to the conversation "${opts.tabName(own)}" (tab ${own}), which has the context` : ', sent to the person at this Mac'}. You are the requests session for ${m.fromName}: their requests come here one at a time, so the conversations here are never interrupted. Treat it as a request from ${m.fromName}. You reach the other conversations only through those marked Shared: terminai list shows them; terminai ask <tab> "<question>" asks one, then end your turn (the question waits until it is free, its answer is typed back here); for a big job, open a new tab with terminai open. Never pass on anything from a conversation that is not Shared. Ask the person here before anything destructive, any purchase or any secret. Reply with: terminai team reply ${m.id} "<answer>"] ${m.content}`
        : tab !== own && own
        ? `[TerminAI · message from ${who}, id ${m.id}, sent to the conversation "${opts.tabName(own)}" (tab ${own}). You are a new side conversation opened to answer it, so that one is not interrupted. Treat it as a request from ${m.fromName}. That conversation has the context: when you need something from it, run terminai ask ${own} "<question>" and end your turn; the question waits until it is free and its answer is typed back here (terminai read ${own} shows its screen). Ask the person here before anything destructive, any purchase or any secret. Reply with: terminai team reply ${m.id} "<answer>"] ${m.content}`
        : `[TerminAI · message from ${who}, id ${m.id}. Treat it as a request from ${m.fromName}: answer what you can from this session; ask the person here before anything destructive, any purchase or any secret. Reply with: terminai team reply ${m.id} "<answer>"] ${m.content}`
      // Control characters out (escape sequences, a carriage return that would submit early); the message cannot fake a second TerminAI header either.
      const safe = (m.self ? text : text.slice(0, text.length - m.content.length) + m.content.replace(/\[TerminAI ·/g, '(TerminAI ·')).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '')
      typed.add(m.id)
      ptys.write(tab, `\x1b[200~${safe}\x1b[201~`)
      await Promise.race([ptys.written(tab), new Promise(r => setTimeout(r, 5000))]); await new Promise(r => setTimeout(r, 200))
      ptys.write(tab, '\r')
      if (viaRequests) { watchTurn(tab); held.add(`u:${m.fromUser}`) }
      await team.call(`/api/companies/${team.id}/agent/${m.id}/delivered`, 'POST', {})
      if (!m.self) opts.notify(m.replyTo ? `Reply from ${m.fromName}'s agent` : `${m.fromName}'s agent → ${opts.tabName(tab)}`, m.content.slice(0, 200), tab)
    }
    return pending
  }
  /** The inbox of an organisation a tab is shared into (not the one picked in Sync), for as long as one is. */
  const listening = new Set<string>()
  function listenTo(company: string): void {
    if (listening.has(company)) return
    listening.add(company)
    void (async () => {
      while (shareCompanies.has(company)) {
        const team = await opts.team().catch(() => null)
        if (!team) { await new Promise(r => setTimeout(r, 30_000)); continue }
        if (team.id === company) break
        try { if (await deliver({ id: company, call: team.call }, false)) await new Promise(r => setTimeout(r, 1500)) }
        catch (err) { console.warn('[teambridge] shared inbox', err instanceof Error ? err.message : err); await new Promise(r => setTimeout(r, 5000)) }
      }
      listening.delete(company)
    })()
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
  // Your other organisations (for conversations shared with you there), looked up once a minute.
  const companyOf = new Map<string, string>()   // conversation id -> its organisation, when not the one picked in Sync
  let orgs: { at: number; list: { id: string; name: string }[] } | null = null
  async function otherOrgs(team: Team): Promise<{ id: string; name: string }[]> {
    if (!orgs || Date.now() - orgs.at > 60_000) orgs = { at: Date.now(), list: ((await team.call('/api/me').catch(() => ({})))?.companies ?? []).map((c: any) => ({ id: c.id, name: c.name })) }
    return orgs.list.filter(c => c.id !== team.id)
  }
  async function command(a: any): Promise<unknown> {
    const team = await opts.team(); if (!team) throw Error('Sign in to TerminAI Sync first (the people icon).')
    const base = `/api/companies/${team.id}`
    const mine = () => { const tab = ptys.liveIds().find(id => id === a.tab); return tab ? conversationOf.get(ptys.workspaceKeyOf(tab)) ?? null : null }
    // Called from a requests session: only conversations marked Shared, never one of this Mac's Only me ones (enforced here, not only in its instructions).
    const limited = typeof a.tab === 'string' && !!opts.isRequests?.(a.tab)
    const sharedOnly = async (id: string) => {
      if (!limited) return
      const { conversation } = await team.call(`${base}/conversations/${id}`).catch(() => ({ conversation: null }))
      if (conversation?.visibility !== 'company') throw Error('A requests session can only reach conversations marked Shared.')
    }
    if (a.action === 'list') {
      const { conversations } = await team.call(`${base}/conversations`)
      const out = (conversations ?? []).filter((c: any) => c.tab && (!limited || c.visibility === 'company')).map((c: any) => ({ ...(c.sharedWithYou ? { sharedWithYou: true } : {}), id: c.id, owner: c.ownerName, title: c.title, folder: c.place, status: c.status, live: c.live, shared: c.visibility === 'company', you: c.id === mine() }))
      // Conversations someone shared with you alone (Share with…) in your other organisations are listed too.
      if (!limited) for (const c of await otherOrgs(team)) {
        const r = await team.call(`/api/companies/${c.id}/conversations`).catch(() => null)
        for (const x of r?.conversations ?? []) if (x.tab && x.sharedWithYou) { companyOf.set(x.id, c.id); out.push({ sharedWithYou: true, organisation: c.name, id: x.id, owner: x.ownerName, title: x.title, folder: x.place, status: x.status, live: x.live, shared: false, you: false }) }
      }
      return out
    }
    if (a.action === 'read') {
      if (typeof a.id !== 'string') throw Error('usage: terminai team read <conversation id>')
      await sharedOnly(a.id)
      const { messages } = await team.call(`/api/companies/${companyOf.get(a.id) ?? team.id}/conversations/${a.id}/messages`)
      const n = Number.isInteger(a.lines) ? a.lines : 12
      return (messages ?? []).slice(-n).map((m: any) => ({ at: m.createdAt, kind: m.kind, text: m.content }))
    }
    // --file: the file goes into the team's Files (folder "From agents") and the message carries a link that opens it in
    // TerminAI's Files pane, plus its id for the other agent (terminai team download <id>).
    const attach = async (text: string): Promise<string> => {
      if (typeof a.file !== 'string') return text
      if (!a.file.startsWith('/')) throw Error('--file needs an absolute path')
      const { file } = await teamUpload(team.id, a.file, 'all', [], false, undefined, 'From agents')
      return `${text}\n\n📎 ${file.name}: terminai://file/${file.id} (opens in TerminAI's Files; agents: terminai team download ${file.id} --to <folder>)`
    }
    if (a.action === 'send' && typeof a.to === 'string') {
      // To a person: their Mac takes it into its requests session for you (one per teammate), which cannot interrupt anything.
      const text = [a.id, a.text].filter(v => typeof v === 'string' && v).join(' ')
      if (!a.to.trim() || !text) throw Error('usage: terminai team send --to <person> <message> [--file <absolute path>]')
      const { members } = await team.call(`${base}/members`)
      const want = a.to.trim().toLowerCase(), all = (members ?? []) as { id: string; name: string; email: string }[]
      const by = (f: (m: { name: string; email: string }) => boolean) => all.filter(f)
      let found = by(m => m.email?.toLowerCase() === want || m.name?.toLowerCase() === want)
      if (!found.length) found = by(m => (m.name ?? '').toLowerCase().split(/\s+/).includes(want))
      if (!found.length) found = by(m => (m.name ?? '').toLowerCase().startsWith(want) || (m.email ?? '').toLowerCase().startsWith(want))
      if (found.length !== 1) throw Error(`${found.length ? 'More than one' : 'No'} member matches "${a.to}". Members: ${all.map(m => m.name).join(', ') || 'none'}.`)
      if (!mine()) await tick()
      const sent = await team.call(`${base}/agent`, 'POST', { toUser: found[0].id, content: await attach(text), from: mine() ?? undefined })
      if (typeof sent?.id === 'string') { sentHere.add(sent.id); if (sentHere.size > 2000) sentHere.delete(sentHere.values().next().value!) }
      return { ...sent, note: `In ${sent.person ?? found[0].name}'s requests session for you${sent.live ? '' : ' when their Mac is online'}; terminai team replies ${sent.id} shows the answer.` }
    }
    if (a.action === 'send') {
      if (typeof a.id !== 'string' || !a.text) throw Error('usage: terminai team send <conversation id> <message> [--file <absolute path>]  or  terminai team send --to <person> <message>')
      await sharedOnly(a.id)
      a.text = await attach(a.text)
      if (!mine()) await tick()
      const sent = await team.call(`${base}/agent`, 'POST', { to: a.id, content: a.text, from: mine() ?? undefined })
      if (typeof sent?.id === 'string') { sentHere.add(sent.id); if (sentHere.size > 2000) sentHere.delete(sentHere.values().next().value!) }
      return sent
    }
    if (a.action === 'reply') {
      if (typeof a.id !== 'string' || !a.text) throw Error('usage: terminai team reply <message id> <answer> [--file <absolute path>]')
      a.text = await attach(a.text)
      // Forgotten since a restart: ask the server who sent it.
      const original = received.get(a.id) ?? await team.call(`${base}/agent/${a.id}/from`).then((r: { from: string | null; bot: boolean; fromUser?: string | null }) => ({ from: r.from, fromName: '', bot: r.bot, fromUser: r.fromUser ?? null })).catch(() => undefined)
      if (original?.bot && !original.from) return { ok: true, note: 'A bot sent it: it reads your answer from this session, so answering here is enough.' }
      // Sent without a session of theirs: the answer goes to the person (their requests session for you).
      if (original && !original.from && original.fromUser) return team.call(`${base}/agent`, 'POST', { toUser: original.fromUser, content: a.text, from: mine() ?? undefined, replyTo: a.id })
      if (!original?.from) throw Error(original ? 'The sender sent it without its session (a tab that is not shared): nothing to reply to. Send a new message to their session with terminai team send.' : 'No such message for this Mac: nothing to reply to.')
      return team.call(`${base}/agent`, 'POST', { to: original.from, content: a.text, from: ('to' in original ? original.to : undefined) ?? mine() ?? undefined, replyTo: a.id })
    }
    if (a.action === 'replies') {
      if (typeof a.id !== 'string') throw Error('usage: terminai team replies <message id>')
      return team.call(`${base}/agent/${a.id}/replies`)
    }
    // A file into the team's shared Files (on the TerminAI server), for everyone or only some products' members.
    if (a.action === 'upload') {
      if (typeof a.id !== 'string' || !a.id.startsWith('/')) throw Error('usage: terminai team upload <absolute file path> [--products A,B] [--as <name>] [--folder <path>]')
      const products = typeof a.products === 'string' ? a.products.split(',').map((p: string) => p.trim()).filter(Boolean) : []
      const { file } = await teamUpload(team.id, a.id, products.length ? 'products' : 'all', products, false, typeof a.as === 'string' ? a.as : undefined, typeof a.folder === 'string' ? a.folder : undefined)
      return { ok: true, id: file.id, folder: file.folder, name: file.name, access: file.access, products: file.products }
    }
    // Team files for agents: list (optionally one folder and what is inside it), download one, or make a share link.
    if (a.action === 'files') {
      const { files } = await teamFiles(team.id), folder = typeof a.folder === 'string' ? a.folder.replace(/^\/+|\/+$/g, '') : ''
      return { files: (files as { id: string; folder?: string; name: string; size: number; access: string; products: string[] | null; shared?: boolean }[])
        .filter(f => !folder || f.folder === folder || (f.folder ?? '').startsWith(`${folder}/`))
        .map(f => ({ id: f.id, path: [f.folder, f.name].filter(Boolean).join('/'), size: f.size, access: f.access, products: f.products, shared: !!f.shared })) }
    }
    if (a.action === 'download') {
      if (typeof a.id !== 'string') throw Error('usage: terminai team download <file id> [--to <absolute folder>]')
      const f = ((await teamFiles(team.id)).files as { id: string; name: string }[]).find(x => x.id === a.id); if (!f) throw Error('No such team file (or not visible to you).')
      const cached = await teamFetch(team.id, f.id, f.name)
      if (typeof a.to !== 'string') return { ok: true, path: cached }
      if (!absolute(a.to)) throw Error('--to must be an absolute folder')
      const dest = joinPath(a.to, f.name); await copyFile(cached, dest); return { ok: true, path: dest }
    }
    if (a.action === 'share') {
      if (typeof a.id !== 'string') throw Error('usage: terminai team share <file id> [--off]')
      return teamFileShare(team.id, a.id, a.off !== true)
    }
    throw Error('usage: terminai team list|read|send|reply|replies|upload|files|download|share')
  }
  // Sessions and turns go up every 5 seconds; messages come down at once (listen).
  return { tick, command, asked: async (keyId: string, conversation: string) => { const t = await opts.team(); if (t) await t.call(`/api/companies/${t.id}/bots/${keyId}/asked`, 'POST', { conversation }) }, conversationFor: (tabId: string): string | null => conversationOf.get(ptys.workspaceKeyOf(tabId)) ?? null, start: () => { setInterval(() => void tick(), 5_000); setTimeout(() => void tick(), 4_000); setTimeout(() => void listen(), 5_000) } }
}
