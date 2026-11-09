import { app } from 'electron'
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { DEFAULT_PREFS, normalizePaneOrder, RAIL_MIN, RAIL_MAX, RAIL_DEFAULT, type Prefs } from '../shared/types'

let cache: Prefs | null = null

function file(): string {
  return join(app.getPath('userData'), 'prefs.json')
}

/** Merge one level deep so a new pref key added later still gets its default. */
function hydrate(raw: unknown): Prefs {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_PREFS }
  const p = raw as Partial<Prefs>
  return {
    ...DEFAULT_PREFS,
    ...p,
    // Files open on the right: moved there once, after that wherever the person drags them.
    paneOrder: p.filesRightV1 ? normalizePaneOrder(p.paneOrder) : [...normalizePaneOrder(p.paneOrder).filter(x => x !== 'files'), 'files'],
    filesRightV1: true,
    toolbarOrder: (() => { const all = DEFAULT_PREFS.toolbarOrder, mine = Array.isArray(p.toolbarOrder) ? p.toolbarOrder.filter((x: unknown) => typeof x === 'string' && all.includes(x)) : []; return [...new Set([...mine, ...all])] })(),
    toolbarRight: Array.isArray(p.toolbarRight) ? p.toolbarRight.filter((x: unknown) => typeof x === 'string' && DEFAULT_PREFS.toolbarOrder.includes(x)) : DEFAULT_PREFS.toolbarRight,
    chatButton: p.chatButton !== false,
    hiddenToolbarItems: Array.isArray(p.hiddenToolbarItems) ? p.hiddenToolbarItems.filter(item => ['files','terminal','browser','team','todo','sessions','maximize','sidebar'].includes(item)) : [],
    // Clamped on read as well as on write: a stale or hand-edited prefs file
    // must never be able to leave the rail off-screen or at zero width.
    railWidth: Math.min(RAIL_MAX, Math.max(RAIL_MIN, p.railWidth ?? RAIL_DEFAULT)),
    railHidden: p.railHidden === true,
    railSide: p.railSide === 'right' ? 'right' : 'left',
    voice: { ...DEFAULT_PREFS.voice, ...(p.voice ?? {}) },
    // Anything but an explicit true means the tour has not been dismissed, so
    // an upgrade from a prefs file that predates this field shows it once.
    seenWelcome: p.seenWelcome === true,
    browserBeta: p.browserBeta === true,
    nightUpdates: p.nightUpdates !== false,
    newTabAgent: p.newTabAgent === 'codex' || p.newTabAgent === 'none' ? p.newTabAgent : 'claude',
    doneNotices: p.doneNotices !== false,
    // Off the record unless chosen: a Mac that never said so shares nothing.
    shareConversations: p.shareConversations === true,
    skippedAccount: p.skippedAccount === true,
    agentMessages: p.agentMessages === 'allow' ? 'allow' : 'ask',
    tabSharing: p.tabSharing && typeof p.tabSharing === 'object' && !Array.isArray(p.tabSharing) ? Object.fromEntries(Object.entries(p.tabSharing).filter(([k, v]) => /^[A-Za-z0-9_-]{1,120}$/.test(k) && typeof v === 'boolean').slice(-500)) as Record<string, boolean> : {},
    folderSharing: p.folderSharing && typeof p.folderSharing === 'object' && !Array.isArray(p.folderSharing) ? Object.fromEntries(Object.entries(p.folderSharing).filter(([k, v]) => typeof k === 'string' && k.length < 1000 && ['shared', 'private', 'off'].includes(v as string)).slice(0, 200)) as Record<string, 'shared' | 'private' | 'off'> : {},
    worklogSkip: Array.isArray(p.worklogSkip) ? p.worklogSkip.filter((x: unknown): x is string => typeof x === 'string').slice(0, 50) : [],
    groupByFolder: p.groupByFolder !== false,
    // A Mac where someone picked Ilai or Matteo keeps the shared page; anyone else gets private lists under a fixed local key.
    teamTasks: p.teamTasks ?? (p.tasksUser === 'livio' || p.tasksUser === 'ilai'),
    tasksUser: p.tasksUser === 'livio' || p.tasksUser === 'ilai' ? p.tasksUser : 'ilai',
    todoHiddenColumns: Array.isArray(p.todoHiddenColumns) ? p.todoHiddenColumns.filter(c => ['livio', 'ilai', 'both'].includes(c)) : [],
    todoProducts: Array.isArray(p.todoProducts) ? p.todoProducts.filter((x): x is string => typeof x === 'string').slice(0, 50) : [],
    todoActivity: p.todoActivity === true,
    todoActivitySeen: typeof p.todoActivitySeen === 'string' ? p.todoActivitySeen : '',
    tabs: Array.isArray(p.tabs) ? p.tabs : [],
  }
}

export function load(): Prefs {
  if (cache) return cache
  try {
    cache = hydrate(JSON.parse(readFileSync(file(), 'utf8')))
  } catch {
    // First launch, or a prefs file we can't parse. Either way defaults are correct.
    cache = { ...DEFAULT_PREFS }
  }
  return cache
}

export function save(patch: Partial<Prefs>): Prefs {
  const next = hydrate({ ...load(), ...patch })
  cache = next
  try {
    mkdirSync(dirname(file()), { recursive: true })
    // Write-then-rename. Tabs are saved on every open/close, so a plain write
    // leaves a window where a truncated file is on disk; reading that back
    // silently resets every preference to its default.
    const tmp = `${file()}.tmp`
    writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8')
    renameSync(tmp, file())
  } catch (err) {
    console.error('[store] could not persist prefs:', err)
  }
  return next
}
