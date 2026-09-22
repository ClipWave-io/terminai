import { app, safeStorage } from 'electron'
import { readFile, writeFile, mkdir, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
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
  const result = input.inviteToken
    ? await request(url, '/api/auth/accept-invite', 'POST', { token: input.inviteToken, name: input.name, password: input.password, client: 'desktop' })
    : await request(url, '/api/auth/login', 'POST', { email: input.email, password: input.password, client: 'desktop' })
  if (typeof result.token !== 'string' || result.token.length < 20) throw new Error('The manager did not return a desktop session.')
  const next = { url, token: result.token }
  await mkdir(app.getPath('userData'), { recursive: true })
  const temporary = file() + '.tmp'
  await writeFile(temporary, safeStorage.encryptString(JSON.stringify(next)), { mode: 0o600 })
  await rename(temporary, file())
  current = next; loaded = true
  return workspaceState()
}
export async function workspaceLogout(): Promise<void> {
  const session = await load()
  try { if (session) await request(session.url, '/api/auth/logout', 'POST', {}, session.token) }
  finally { current = null; loaded = true; await unlink(file()).catch(() => {}) }
}
export async function workspaceRequest(path: string, method = 'GET', body?: unknown): Promise<any> {
  // This is deliberately a narrow API bridge, not an authenticated fetch proxy.
  if (!/^\/api\/companies\/[a-zA-Z0-9-]+\/(catalog|members|conversations)(\/[a-zA-Z0-9-]+)?(\/messages)?$/.test(path)
    || !['GET', 'POST', 'PATCH'].includes(method)) throw new Error('Unsupported workspace action.')
  const session = await load()
  if (!session) throw new Error('Sign in to your company workspace first.')
  if (body !== undefined && JSON.stringify(body).length > 70000) throw new Error('This message is too large.')
  return request(session.url, path, method, body, session.token)
}
