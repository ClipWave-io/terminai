import { app, type BrowserWindow } from 'electron'
import { readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

/**
 * The notification center: everything TerminAI tells you (a conversation finished, To-do changes, requests, team chat,
 * messages from agents and bots, memory, updates) kept in one list on this Mac, the last 300, whether or not macOS
 * showed it. The bell in the top bar reads it.
 */
export type NoticeKind = 'done' | 'todo' | 'request' | 'chat' | 'agent' | 'memory' | 'update'
export type NoticeTarget = { tab?: string; open?: 'todos' | 'activity' | 'chat' | 'memory' | 'updates' }
export type Notice = { id: string; kind: NoticeKind; title: string; body: string; at: string; read: boolean; target?: NoticeTarget }
const file = () => join(app.getPath('userData'), 'notices.json')
let list: Notice[] | null = null, win: (() => BrowserWindow | null) = () => null
const load = (): Notice[] => { if (!list) { try { list = JSON.parse(readFileSync(file(), 'utf8')) } catch { list = [] } } return list! }
const save = () => { try { writeFileSync(`${file()}.tmp`, JSON.stringify(list!.slice(0, 300))); renameSync(`${file()}.tmp`, file()) } catch {} }
export function noticesWindow(w: () => BrowserWindow | null): void { win = w }
/** `read`: you are already looking at it (the tab that finished is open in front). */
export function notice(kind: NoticeKind, title: string, body: string, target?: NoticeTarget, read = false): void {
  const n: Notice = { id: randomUUID(), kind, title: title.slice(0, 160), body: body.slice(0, 600), at: new Date().toISOString(), read, ...(target ? { target } : {}) }
  list = [n, ...load()].slice(0, 300); save()
  const w = win(); if (w && !w.isDestroyed()) w.webContents.send('notices:new', n)
}
export const noticesList = (): Notice[] => load()
export function noticesRead(ids: unknown): Notice[] {
  const all = ids === 'all', set = new Set(Array.isArray(ids) ? ids : [])
  list = load().map(n => all || set.has(n.id) ? { ...n, read: true } : n); save(); return list
}
export function noticesClear(): Notice[] { list = []; save(); return list }
