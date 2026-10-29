import { app, safeStorage, shell } from 'electron'
import { readFile, writeFile, mkdir, rename, unlink, stat } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { DEFAULT_WORKSPACE_URL } from '../shared/workspace'
import type { WorkspaceIdentity, WorkspaceLogin, WorkspaceState } from '../shared/workspace'

// The token never enters the renderer, terminal environment, or prefs file.
type Session = { url: string; token: string }
let current: Session | null = null
let loaded = false
const file = () => join(app.getPath('userData'), 'workspace-session.enc')
export function managerOrigin(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048) throw new Error('Enter your workspace manager URL.')
  const url = new URL(value)
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
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
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
    ? await request(url, '/api/auth/accept-invite', 'POST', { token: input.inviteToken, name: input.name, password: input.password, client: 'desktop' })
    : await request(url, '/api/auth/login', 'POST', { email: input.email, password: input.password, client: 'desktop' })
  return keep(url, result)
}
async function keep(url: string, result: any): Promise<WorkspaceState> {
  if (typeof result.token !== 'string' || result.token.length < 20) throw new Error('The manager did not return a desktop session.')
  const next = { url, token: result.token }
  await mkdir(app.getPath('userData'), { recursive: true })
  const temporary = file() + '.tmp'
  await writeFile(temporary, safeStorage.encryptString(JSON.stringify(next)), { mode: 0o600 })
  await rename(temporary, file())
  current = next; loaded = true
  return workspaceState()
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
  finally { current = null; loaded = true; await unlink(file()).catch(() => {}) }
}
export async function workspaceRequest(path: string, method = 'GET', body?: unknown): Promise<any> {
  // This is deliberately a narrow API bridge, not an authenticated fetch proxy.
  const file = /^\/api\/companies\/[a-zA-Z0-9-]+\/notes\/[a-zA-Z0-9-]+\/files\/[a-zA-Z0-9-]+$/.test(path)
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
