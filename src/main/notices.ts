import { app, type BrowserWindow } from 'electron'
import { execFile } from 'node:child_process'
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

/**
 * Sounds: each kind its own macOS system sound, played by the app itself (afplay), so it rings whether or not macOS
 * shows the notification and whatever the window is doing. Settings › Notifications › Sounds turns each kind on or off.
 */
export const SOUND_FILES: Record<string, string> = { chat: 'Pop', call: 'Ping', done: 'Glass', request: 'Hero', agent: 'Purr', todo: 'Tink', memory: 'Basso', update: 'Bottle' }
let soundOn: (kind: string) => boolean = () => true, soundName: (kind: string) => string | undefined = () => undefined
const lastSound = new Map<string, number>()
export function noticesSound(on: (kind: string) => boolean, name?: (kind: string) => string | undefined): void { soundOn = on; if (name) soundName = name }
export function playSound(kind: string, force = false, override?: string): void {
  const name = (override && /^[A-Za-z]+$/.test(override) ? override : undefined) ?? soundName(kind) ?? SOUND_FILES[kind]; if (!name || (!force && !soundOn(kind))) return
  // One per kind every 1.5 s: ten messages arriving together ring once.
  if (!force && Date.now() - (lastSound.get(kind) ?? 0) < 1500) return
  lastSound.set(kind, Date.now())
  execFile('/usr/bin/afplay', ['-v', '0.7', `/System/Library/Sounds/${name}.aiff`], () => {})
}
/** `read`: you are already looking at it (the tab that finished is open in front). */
export function notice(kind: NoticeKind, title: string, body: string, target?: NoticeTarget, read = false): void {
  const n: Notice = { id: randomUUID(), kind, title: title.slice(0, 160), body: body.slice(0, 600), at: new Date().toISOString(), read, ...(target ? { target } : {}) }
  list = [n, ...load()].slice(0, 300); save()
  if (!read) playSound(kind)
  const w = win(); if (w && !w.isDestroyed()) w.webContents.send('notices:new', n)
}
export const noticesList = (): Notice[] => load()
export function noticesRead(ids: unknown): Notice[] {
  const all = ids === 'all', set = new Set(Array.isArray(ids) ? ids : [])
  list = load().map(n => all || set.has(n.id) ? { ...n, read: true } : n); save(); return list
}
export function noticesClear(): Notice[] { list = []; save(); return list }
