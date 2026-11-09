import { app, safeStorage, shell } from 'electron'
import { readFile, writeFile, mkdir, rename, unlink, stat } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { DEFAULT_WORKSPACE_URL } from '../shared/workspace'
import type { WorkspaceIdentity, WorkspaceLogin, WorkspaceState } from '../shared/workspace'

// The token never enters the renderer, terminal environment, or prefs file.
type Session = { url: string; token: string }
let current: Session | null = null
let loaded = false
// Which workspace holds the To-do (workspaceTasks below); forgotten whenever the account changes.
let tasksWorkspace: { user: string; id: string } | null = null
const file = () => join(app.getPath('userData'), 'workspace-session.enc')
export function managerOrigin(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048) throw new Error('Enter your workspace manager URL.')
  const url = new URL(value)
  // Test builds may use a manager on this Mac (UI tests); the installed app never does.
  if (globalThis.process?.env?.TERMINAI_TEST_BUILD && url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.pathname === '/') return url.origin
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash)
    throw new Error('Use the HTTPS address of your workspace manager, without a path.')
  return url.origin
}
async function load(): Promise<Session | null> {
  if (loaded) return current
  loaded = true
  try {
    if (!safeStorage.isEncryptionAvailable()) return null
    const row = JSON.parse(safeStorage.decryptString(await readFile(file())))
    current = { url: managerOrigin(row.url), token: String(row.token) }
  } catch { current = null }
  return current
}
async function request(url: string, path: string, method: string, body?: unknown, token?: string): Promise<any> {
  const response = await fetch(url + path, {
    method, redirect: 'error', signal: AbortSignal.timeout(15000),
    headers: { 'Content-Type': 'application/json', 'X-TerminAI-Version': app.getVersion?.() ?? '', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const value = await response.json().catch(() => ({})) as any
  if (!response.ok) {
    if (response.status === 401 && token) { current = null; await unlink(file()).catch(() => {}) }
    throw new Error(typeof value.error === 'string' ? value.error.slice(0,240) : `Workspace request failed (${response.status}).`)
  }
  return value
}
export async function workspaceState(): Promise<WorkspaceState> {
  const session = await load()
  if (!session) return { url: DEFAULT_WORKSPACE_URL, signedIn: false }
  const identity: WorkspaceIdentity = await request(session.url, '/api/me', 'GET', undefined, session.token)
  return { url: session.url, signedIn: true, identity }
}
export async function workspaceLogin(input: WorkspaceLogin): Promise<WorkspaceState> {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Unlock your macOS keychain before signing in.')
  const url = managerOrigin(input.url)
  const result = input.signup
    ? await request(url, '/api/auth/signup', 'POST', { name: input.name, email: input.email, companyName: input.companyName || undefined, password: input.password, client: 'desktop' })
    : input.inviteToken
    ? await request(url, '/api/auth/accept-invite', 'POST', { token: input.inviteToken, name: input.name, email: input.email, password: input.password || undefined, client: 'desktop' })
    : await request(url, '/api/auth/login', 'POST', { email: input.email, password: input.password, client: 'desktop' })
  return keep(url, result)
}
async function keep(url: string, result: any): Promise<WorkspaceState> {
  if (typeof result.token !== 'string' || result.token.length < 20) throw new Error('The manager did not return a desktop session.')
  const next = { url, token: result.token }
  tasksWorkspace = null
  await mkdir(app.getPath('userData'), { recursive: true })
  const temporary = file() + '.tmp'
  await writeFile(temporary, safeStorage.encryptString(JSON.stringify(next)), { mode: 0o600 })
  await rename(temporary, file())
  current = next; loaded = true
  return workspaceState()
}
/** terminai://signin?code=…&server=…: the website's "Open TerminAI" hands this Mac a session. Only the TerminAI server, or the one already in use. */
export async function workspaceHandoff(link: string): Promise<WorkspaceState> {
  const url = new URL(link), code = url.searchParams.get('code') ?? '', server = managerOrigin(url.searchParams.get('server') ?? DEFAULT_WORKSPACE_URL)
  if (url.hostname !== 'signin' || !/^[A-Za-z0-9_-]{43}$/.test(code)) throw new Error('Invalid sign-in link.')
  const known = (await load())?.url
  if (server !== DEFAULT_WORKSPACE_URL && server !== known) throw new Error('That sign-in link is for another server.')
  return keep(server, await request(server, '/api/auth/device/poll', 'POST', { pollToken: code }))
}
/** Whether this Mac has an account session, read locally so a server outage never locks anyone out. Test builds skip the gate. */
/**
 * Sign in with the browser: the website, where people usually are signed in already, allows this Mac after
 * showing the same code. Start opens it and returns the code; wait resolves once allowed (or fails, or is cancelled).
 */
let pending: { url: string; pollToken: string; until: number; cancelled: boolean } | null = null
export async function workspaceBrowserLoginStart(input: unknown): Promise<{ code: string }> {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Unlock your macOS keychain before signing in.')
  const url = managerOrigin(input)
  const started = await request(url, '/api/auth/device/start', 'POST', {})
  if (typeof started.pollToken !== 'string' || typeof started.code !== 'string' || typeof started.verifyUrl !== 'string' || new URL(started.verifyUrl).origin !== url)
    throw new Error('The server did not start a browser sign-in.')
  if (pending) pending.cancelled = true
  pending = { url, pollToken: started.pollToken, until: Date.now() + Math.min(Number(started.expiresIn) || 600, 900) * 1000, cancelled: false }
  if (!process.env.TERMINAI_TEST_BUILD) await shell.openExternal(started.verifyUrl)
  return { code: started.code }
}
export async function workspaceBrowserLoginWait(): Promise<WorkspaceState> {
  const attempt = pending
  if (!attempt) throw new Error('Start the browser sign-in first.')
  while (!attempt.cancelled && Date.now() < attempt.until) {
    await new Promise(resolve => setTimeout(resolve, 2000))
    if (attempt.cancelled) break
    const result = await request(attempt.url, '/api/auth/device/poll', 'POST', { pollToken: attempt.pollToken })
    if (!result.pending) { if (pending === attempt) pending = null; return keep(attempt.url, result) }
  }
  if (pending === attempt) pending = null
  throw new Error(attempt.cancelled ? 'Cancelled.' : 'The sign-in expired. Try again.')
}
export function workspaceBrowserLoginCancel(): void { if (pending) pending.cancelled = true; pending = null }
export async function workspaceHasAccount(): Promise<boolean> {
  if (process.env.TERMINAI_TEST_BUILD && !process.env.TERMINAI_TEST_ACCOUNT_GATE) return true
  return (await load()) !== null
}
export async function workspaceLogout(): Promise<void> {
  const session = await load()
  try { if (session) await request(session.url, '/api/auth/logout', 'POST', {}, session.token) }
  finally { current = null; loaded = true; tasksWorkspace = null; await unlink(file()).catch(() => {}) }
}
export async function workspaceRequest(path: string, method = 'GET', body?: unknown): Promise<any> {
  // This is deliberately a narrow API bridge, not an authenticated fetch proxy.
  const rename = (path === '/api/me' && method === 'PATCH') || (path === '/api/auth/device/approve' && method === 'POST') || (path === '/api/auth/password' && method === 'POST'),
    invite = (/^\/api\/companies\/[a-zA-Z0-9-]+\/invites(\/link)?$/.test(path) && method === 'POST') || (/^\/api\/companies\/[a-zA-Z0-9-]+\/bots(\/[a-f0-9-]{36})?$/.test(path) && ['GET', 'POST', 'DELETE'].includes(method))
    || (/^\/api\/companies\/[a-zA-Z0-9-]+$/.test(path) && method === 'PATCH')
  const file = /^\/api\/companies\/[a-zA-Z0-9-]+\/notes\/[a-zA-Z0-9-]+\/files\/[a-zA-Z0-9-]+$/.test(path)
  if (rename || invite) {
    const session = await load()
    if (!session) throw new Error('Sign in to your company workspace first.')
    return request(session.url, path, method, body, session.token)
  }
  if (file ? method !== 'DELETE' : (!/^\/api\/companies\/[a-zA-Z0-9-]+\/(catalog|members|conversations|notes)(\/[a-zA-Z0-9-]+)?(\/messages)?$/.test(path)
    || !['GET', 'POST', 'PATCH', 'DELETE'].includes(method)
    || (method === 'DELETE' && !/\/notes\/[a-zA-Z0-9-]+$/.test(path)))) throw new Error('Unsupported workspace action.')
  const session = await load()
  if (!session) throw new Error('Sign in to your company workspace first.')
  if (body !== undefined && JSON.stringify(body).length > 70000) throw new Error('This message is too large.')
  return request(session.url, path, method, body, session.token)
}

// Files in shared notes. The renderer names a note and a file on disk; the bytes go straight from here to the manager.
const notePath = /^\/api\/companies\/[a-zA-Z0-9-]+\/notes\/[a-zA-Z0-9-]+$/
const TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.heic': 'image/heic',
  '.pdf': 'application/pdf', '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv', '.json': 'application/json', '.zip': 'application/zip',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation', '.pages': 'application/x-iwork-pages', '.key': 'application/x-iwork-keynote', '.numbers': 'application/x-iwork-numbers' }
export async function workspaceAttach(note: string, filePath: string): Promise<any> {
  if (typeof note !== 'string' || !notePath.test(note) || typeof filePath !== 'string') throw new Error('Unsupported workspace action.')
  const info = await stat(filePath)
  if (!info.isFile()) throw new Error('Only files can be added to a note.')
  if (info.size > 25 * 1024 * 1024) throw new Error(`${basename(filePath)} is larger than 25 MB.`)
  const session = await load()
  if (!session) throw new Error('Sign in with Sync first.')
  const query = new URLSearchParams({ name: basename(filePath), type: TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream' })
  const response = await fetch(`${session.url}${note}/files?${query}`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(120000),
    headers: { 'Content-Type': 'application/octet-stream', Authorization: `Bearer ${session.token}` }, body: await readFile(filePath) })
  const value = await response.json().catch(() => ({})) as any
  if (!response.ok) throw new Error(typeof value.error === 'string' ? value.error.slice(0, 240) : `Upload failed (${response.status}).`)
  return value
}
/** Downloads a note's file into this Mac's cache and returns where it is, for the Files pane. */
export async function workspaceFetchFile(note: string, fileId: string, name: string): Promise<string> {
  if (typeof note !== 'string' || !notePath.test(note) || typeof fileId !== 'string' || !/^[a-zA-Z0-9-]{1,64}$/.test(fileId)) throw new Error('Unsupported workspace action.')
  const session = await load()
  if (!session) throw new Error('Sign in with Sync first.')
  const safe = String(name).replace(/[\\/:\u0000-\u001f]/g, '_').replace(/^\.+/, '').slice(0, 200) || 'file'
  const directory = join(app.getPath('userData'), 'note-files', fileId), target = join(directory, safe)
  try { if ((await stat(target)).isFile()) return target } catch {}
  const response = await fetch(`${session.url}${note}/files/${fileId}`, { redirect: 'error', signal: AbortSignal.timeout(120000), headers: { Authorization: `Bearer ${session.token}` } })
  if (!response.ok) throw new Error(`Could not get ${safe} (${response.status}).`)
  await mkdir(directory, { recursive: true })
  await writeFile(target + '.part', Buffer.from(await response.arrayBuffer()), { mode: 0o600 })
  await rename(target + '.part', target)
  return target
}

// The To-do's shared page on the server (see todos.ts mirror). Main process only: never reachable from the renderer.
// The workspace is the one this person's To-do column is registered in; the first time, the first one they are in.
export async function teamOf(user: string): Promise<{ id: string; call: (path: string, method?: string, body?: unknown) => Promise<any> } | null> {
  const session = await load()
  if (!session) return null
  const call = (path: string, method = 'GET', body?: unknown) => request(session.url, path, method, body, session.token)
  if (tasksWorkspace?.user !== user) {
    const me = await call('/api/me')
    const ids: string[] = (me.companies ?? []).map((c: { id: string }) => c.id)
    let pick = ''
    for (const id of ids) if ((await call(`/api/companies/${id}/tasks`)).me === user) { pick = id; break }
    if (!pick) pick = ids[0] ?? ''
    if (!pick) return null
    await call(`/api/companies/${pick}/tasks/people`, 'PUT', { key: user })
    tasksWorkspace = { user, id: pick }
  }
  return { id: tasksWorkspace.id, call }
}
/** The work log of the To-do's workspace (worklog.ts): this person writes their day, everyone reads all. */
export const workspaceWorklog = {
  async put(user: string, day: string, data: unknown): Promise<void> {
    const team = await teamOf(user); if (team) await team.call(`/api/companies/${team.id}/worklog/${day}`, 'PUT', { data })
  },
  async get(user: string, day: string): Promise<Record<string, any> | null> {
    const team = await teamOf(user); return team ? (await team.call(`/api/companies/${team.id}/worklog/${day}`)).people ?? {} : null
  },
}
export const workspaceTasks = {
  async load(user: string): Promise<{ workspace: string; tasks: any[]; deleted: any[] } | null> {
    const team = await teamOf(user)
    if (!team) return null
    const call = team.call
    const value = await call(`/api/companies/${team.id}/tasks`)
    return { workspace: team.id, tasks: value.tasks ?? [], deleted: value.deleted ?? [] }
  },
  async put(workspace: string, task: unknown): Promise<void> {
    const session = await load(); if (!session) return
    await request(session.url, `/api/companies/${workspace}/tasks/${encodeURIComponent((task as { id: string }).id)}`, 'PUT', { task }, session.token)
  },
  async remove(workspace: string, id: string): Promise<void> {
    const session = await load(); if (!session) return
    await request(session.url, `/api/companies/${workspace}/tasks/${encodeURIComponent(id)}`, 'DELETE', undefined, session.token)
  },
}

// Team chat and team files. The renderer names the company and the action; this side checks it and holds the token.
const companyId = (id: unknown) => { if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id)) throw new Error('Unsupported workspace action.'); return id }
async function authed(path: string, init: RequestInit & { timeout?: number } = {}): Promise<Response> {
  const session = await load()
  if (!session) throw new Error('Sign in with Sync first.')
  const response = await fetch(session.url + path, { ...init, redirect: 'error', signal: AbortSignal.timeout(init.timeout ?? 15000),
    headers: { 'X-TerminAI-Version': app.getVersion?.() ?? '', Authorization: `Bearer ${session.token}`, ...(init.headers ?? {}) } })
  if (!response.ok) { const v = await response.json().catch(() => ({})) as any; throw new Error(typeof v.error === 'string' ? v.error.slice(0, 240) : `Request failed (${response.status}).`) }
  return response
}
const jsonOf = (r: Response) => r.json() as Promise<any>
/** The chat's long poll: new messages after `after`, people with last seen and typing; waits up to 25 s for a change. */
export async function teamChat(company: unknown, after?: string, typing = ''): Promise<any> {
  const q = new URLSearchParams({ wait: after ? '25' : '0', typing: String(typing).slice(0, 400), ...(after ? { after } : {}) })
  return jsonOf(await authed(`/api/companies/${companyId(company)}/chat?${q}`, { timeout: 40000 }))
}
export async function teamSend(company: unknown, body: unknown, fileId?: unknown): Promise<any> {
  if (typeof body !== 'string' || body.length > 8000 || (fileId !== undefined && (typeof fileId !== 'string' || !/^[0-9a-f-]{36}$/.test(fileId)))) throw new Error('Invalid message.')
  return jsonOf(await authed(`/api/companies/${companyId(company)}/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body, ...(fileId ? { fileId } : {}) }) }))
}
export async function teamSignal(company: unknown, kind: unknown): Promise<void> {
  if (kind !== 'typing' && kind !== 'read') throw new Error('Unsupported workspace action.')
  await authed(`/api/companies/${companyId(company)}/chat/${kind}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
}
export async function teamFiles(company: unknown): Promise<any> { return jsonOf(await authed(`/api/companies/${companyId(company)}/files`)) }
export async function teamFileChange(company: unknown, fileId: unknown, change: unknown): Promise<any> {
  if (typeof fileId !== 'string' || !/^[0-9a-f-]{36}$/.test(fileId)) throw new Error('Unsupported workspace action.')
  const path = `/api/companies/${companyId(company)}/files/${fileId}`
  if (change === null) return jsonOf(await authed(path, { method: 'DELETE' }))
  if (!change || typeof change !== 'object' || JSON.stringify(change).length > 4000) throw new Error('Invalid change.')
  return jsonOf(await authed(path, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(change) }))
}
/** Uploads a file from disk to the team space; the bytes never pass through the renderer. */
export async function teamUpload(company: unknown, filePath: unknown, access: unknown = 'all', products: unknown = [], chat = false): Promise<any> {
  if (typeof filePath !== 'string' || !['all', 'admins', 'products'].includes(String(access)) || !Array.isArray(products)) throw new Error('Unsupported workspace action.')
  const info = await stat(filePath)
  if (!info.isFile()) throw new Error('Only files can be shared.')
  if (info.size > 25 * 1024 * 1024) throw new Error(`${basename(filePath)} is larger than 25 MB.`)
  const q = new URLSearchParams({ name: basename(filePath), type: TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream', access: String(access), products: products.map(String).join(','), ...(chat ? { chat: '1' } : {}) })
  return jsonOf(await authed(`/api/companies/${companyId(company)}/files?${q}`, { method: 'POST', timeout: 180000, headers: { 'Content-Type': 'application/octet-stream' }, body: await readFile(filePath) }))
}
/** A team file in this Mac's cache, downloaded the first time it is opened; files never change, so the cache is kept. */
export async function teamFetch(company: unknown, fileId: unknown, name: unknown): Promise<string> {
  if (typeof fileId !== 'string' || !/^[0-9a-f-]{36}$/.test(fileId)) throw new Error('Unsupported workspace action.')
  const safe = String(name).replace(/[\\/:\u0000-\u001f]/g, '_').replace(/^\.+/, '').slice(0, 200) || 'file'
  const directory = join(app.getPath('userData'), 'team-files', fileId), target = join(directory, safe)
  try { if ((await stat(target)).isFile()) return target } catch {}
  const response = await authed(`/api/companies/${companyId(company)}/files/${fileId}`, { timeout: 180000 })
  await mkdir(directory, { recursive: true })
  await writeFile(target + '.part', Buffer.from(await response.arrayBuffer()), { mode: 0o600 })
  await rename(target + '.part', target)
  return target
}
const IMAGE = /\.(png|jpe?g|gif|webp)$/i
/** An image shown in the chat, as a data URL (from the cache after the first time). */
export async function teamImage(company: unknown, fileId: unknown, name: unknown): Promise<string> {
  if (!IMAGE.test(String(name))) throw new Error('Not an image.')
  const path = await teamFetch(company, fileId, name)
  const ext = extname(path).slice(1).toLowerCase()
  return `data:image/${ext === 'jpg' ? 'jpeg' : ext};base64,${(await readFile(path)).toString('base64')}`
}
