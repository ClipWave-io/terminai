import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Task, TaskInput, TaskList, TaskScope, TasksChange, TasksSync, TasksUser, TaskVersion } from '../shared/types'

/**
 * The To-do sheet's data. Personal tasks are one JSON file per user in userData and never leave the Mac.
 * Shared tasks live in a clone of the build-tasks repo (one file per task, see its README) that
 * this module pulls, commits and pushes by itself, with the user's own git and credential helper.
 * Sessions read the same files through `terminai todo`; nothing else writes them.
 */
export const DEFAULT_TASKS_REMOTE = 'https://github.com/ClipWave-io/build-tasks.git'

const STATUSES = ['open', 'doing', 'done']
const ASSIGNEES = ['livio', 'ilai', 'both']
const validId = (id: unknown): id is string => typeof id === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(id)

/** ISO time with the Europe/Rome offset, e.g. 2026-10-20T16:21:03.120+02:00. */
export function romeIso(date = new Date()): string {
  const part = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Rome', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(date).map(p => [p.type, p.value]))
  const ms = date.getUTCMilliseconds()
  const offset = Math.round((Date.UTC(+part.year, +part.month - 1, +part.day, +part.hour, +part.minute, +part.second, ms) - date.getTime()) / 60000)
  const pad = (n: number, width = 2) => String(n).padStart(width, '0')
  return `${part.year}-${part.month}-${part.day}T${part.hour}:${part.minute}:${part.second}.${pad(ms, 3)}${offset < 0 ? '-' : '+'}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`
}

/** execFile, never a shell. No prompts: a missing credential fails instead of hanging the sync. */
function git(cwd: string, ...args: string[]): Promise<string> {
  return new Promise((resolve, reject) => execFile('git', args, { cwd, timeout: 60_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true' } }, (err, stdout, stderr) => {
    if (!err) return resolve(stdout)
    const lines = String(stderr || err.message).split('\n').map(line => line.trim()).filter(Boolean)
    reject(new Error(lines.find(line => /^(fatal|error):/.test(line)) ?? lines.pop() ?? 'git failed'))
  }))
}

export function createTodos(dir: string, opts: { remote: string; user: () => TasksUser | ''; changed: () => void; notify?: (change: TasksChange) => void }) {
  // Before private tasks were per user they were one file per Mac (todos-personal.json).
  const legacyFile = join(dir, 'todos-personal.json')
  const personalFile = (user: TasksUser) => join(dir, `todos-personal-${user}.json`)
  const clone = join(dir, 'build-tasks')
  const tasksDir = join(clone, 'tasks')
  const status: TasksSync = { enabled: Boolean(opts.remote), syncing: false, lastSync: null, error: opts.remote ? null : 'No shared repository is set for this build.' }

  function readList(file: string): Task[] {
    try { const list = JSON.parse(readFileSync(file, 'utf8')); return Array.isArray(list) ? list : [] } catch { return [] }
  }
  function writeList(file: string, list: Task[]): void {
    // Write-then-rename, as store.ts does for prefs.
    const tmp = `${file}.tmp`
    writeFileSync(tmp, JSON.stringify(list, null, 2) + '\n', 'utf8')
    renameSync(tmp, file)
  }
  /** The old per-Mac file, split once: each task goes to whoever created it, the rest to the current user. */
  function migrate(user: TasksUser): void {
    if (!existsSync(legacyFile)) return
    const old = readList(legacyFile)
    for (const owner of ['livio', 'ilai'] as const) {
      const moving = old.filter(task => (task?.createdBy === 'livio' || task?.createdBy === 'ilai' ? task.createdBy : user) === owner)
      if (!moving.length) continue
      const have = readList(personalFile(owner)), ids = new Set(have.map(task => task.id))
      writeList(personalFile(owner), [...have, ...moving.filter(task => !ids.has(task.id))])
    }
    renameSync(legacyFile, `${legacyFile}.migrated`)
  }
  function readPersonal(user: TasksUser): Task[] {
    migrate(user)
    return readList(personalFile(user))
  }
  const writePersonal = (user: TasksUser, list: Task[]) => writeList(personalFile(user), list)
  function readTask(file: string): Task | undefined {
    try { const task = JSON.parse(readFileSync(file, 'utf8')); return task && typeof task === 'object' ? task : undefined } catch { return undefined }
  }
  function readShared(): Task[] {
    let names: string[] = []
    try { names = readdirSync(tasksDir).filter(name => name.endsWith('.json')) } catch { return [] }
    return names.flatMap(name => readTask(join(tasksDir, name)) ?? [])
  }
  // ---- what the other one changed --------------------------------------------
  /** Per person on this Mac: the updatedAt of each shared task as they last saw it. */
  const seenFile = (user: TasksUser) => join(dir, `todos-seen-${user}.json`)
  function readSeen(user: TasksUser): Record<string, string> | null {
    try { const seen = JSON.parse(readFileSync(seenFile(user), 'utf8')); return seen && typeof seen === 'object' ? seen : null } catch { return null }
  }
  function writeSeen(user: TasksUser, seen: Record<string, string>): void {
    const tmp = `${seenFile(user)}.tmp`
    writeFileSync(tmp, JSON.stringify(seen, null, 2) + '\n', 'utf8')
    renameSync(tmp, seenFile(user))
  }
  /** Shared tasks the other person added or changed since this person last looked. The first look, once the repo is cloned, takes everything as seen. */
  function unseen(user: TasksUser, shared: Task[]): string[] {
    let seen = readSeen(user)
    if (!seen) {
      if (!existsSync(join(clone, '.git'))) return []
      seen = Object.fromEntries(shared.map(task => [task.id, task.updatedAt]))
      writeSeen(user, seen)
    }
    return shared.filter(task => task.updatedBy !== user && seen![task.id] !== task.updatedAt).map(task => task.id)
  }

  const list = (): TaskList => {
    const user = opts.user(), shared = readShared()
    return { personal: user ? readPersonal(user) : [], shared, sync: { ...status }, unseen: user ? unseen(user, shared) : [] }
  }

  function who(): TasksUser {
    const user = opts.user()
    if (!user) throw Error('Choose who you are first.')
    return user
  }
  /** Rejects bad input before any file or git work, so it never shows up as a sync error. */
  function check(input: TaskInput): void {
    if (input.id !== undefined && !validId(input.id)) throw Error('Invalid task id')
    for (const [field, max] of [['title', 300], ['notes', 20000], ['product', 100]] as const) {
      const value = input[field]
      if (value !== undefined && (typeof value !== 'string' || value.length > max)) throw Error(`Invalid ${field}`)
    }
    if ((input.id === undefined || input.title !== undefined) && !input.title?.trim()) throw Error('A task needs a title.')
    if (input.status !== undefined && !STATUSES.includes(input.status)) throw Error('Invalid status')
    if (input.assignee !== undefined && input.assignee !== null && !ASSIGNEES.includes(input.assignee)) throw Error('Invalid assignee')
    if (input.order !== undefined && !Number.isFinite(input.order)) throw Error('Invalid order')
  }
  /** The fields of a task in the order the files have them; `order` only when it is set. */
  const clean = ({ id, title, notes, status, assignee, product, order, createdAt, createdBy, updatedAt, updatedBy }: Task): Task =>
    ({ id, title, notes, status, assignee, product, ...(order === undefined ? {} : { order }), createdAt, createdBy, updatedAt, updatedBy })
  function build(input: TaskInput, old: Task | undefined, user: TasksUser): Task {
    const now = romeIso()
    // Moving a task up or down its list is not an edit: in a conflict, a change to its content on the other Mac still wins.
    const kept = old && Object.entries(input).every(([field, value]) => field === 'id' || field === 'order' || value === undefined) ? old : undefined
    return clean({
      id: old?.id ?? randomUUID(),
      title: input.title?.trim() ?? old?.title ?? '',
      notes: input.notes?.trim() ?? old?.notes ?? '',
      status: input.status ?? old?.status ?? 'open',
      assignee: input.assignee === undefined ? old?.assignee ?? null : input.assignee,
      product: input.product?.trim() ?? old?.product ?? '',
      order: input.order ?? old?.order,
      createdAt: old?.createdAt ?? now, createdBy: old?.createdBy ?? user, updatedAt: kept?.updatedAt ?? now, updatedBy: kept?.updatedBy ?? user,
    })
  }
  /** The verb in the commit message, e.g. "livio: done Fix login". */
  function verb(old: Task | undefined, next: Task): string {
    if (!old) return 'add'
    if (old.status !== next.status) return next.status === 'done' ? 'done' : next.status === 'doing' ? 'start' : 'reopen'
    if (old.assignee !== next.assignee) return `assign to ${next.assignee ?? 'nobody'}`
    if (old.order !== next.order && old.title === next.title && old.notes === next.notes && old.product === next.product) return 'reorder'
    return 'edit'
  }
  /** "Fix login", or "Fix login, Deploy, Call Ilai and 2 more" when a commit carries several tasks. */
  const titles = (tasks: Task[]) => tasks.slice(0, 3).map(task => task.title).join(', ') + (tasks.length > 3 ? ` and ${tasks.length - 3} more` : '')

  // ---- git ----------------------------------------------------------------
  let chain: Promise<unknown> = Promise.resolve()
  /** One git job at a time: the 3-minute sync and the user's edits must never overlap. */
  function job(work: () => Promise<void>): Promise<void> {
    const run = chain.then(async () => {
      status.syncing = true
      opts.changed()
      try {
        await work()
        status.error = null
        status.lastSync = romeIso()
      } catch (err) {
        status.error = err instanceof Error ? err.message : String(err)
        throw err
      } finally {
        status.syncing = false
        opts.changed()
      }
    })
    chain = run.catch(() => {})
    return run
  }
  const rebasing = () => existsSync(join(clone, '.git', 'rebase-merge')) || existsSync(join(clone, '.git', 'rebase-apply'))
  const show = (spec: string) => git(clone, 'show', spec).catch(() => null)
  const stamp = (json: string | null) => { try { return Date.parse(JSON.parse(json!).updatedAt) || 0 } catch { return 0 } }
  const titleOf = (json: string) => { try { return String(JSON.parse(json).title) } catch { return 'task' } }

  async function ready(): Promise<boolean> {
    if (!opts.remote) throw Error(status.error ?? 'No shared repository is set for this build.')
    if (!existsSync(join(clone, '.git'))) {
      await git(dir, 'clone', '-q', opts.remote, clone)
      return true
    }
    if (rebasing()) await git(clone, 'rebase', '--abort')
    // A change written but never committed (the app quit in between) would block every pull.
    if ((await git(clone, 'status', '--porcelain')).trim()) {
      await git(clone, 'add', '-A')
      await git(clone, 'commit', '-q', '-m', `${who()}: save unsynced changes`)
    }
    return false
  }

  /**
   * pull --rebase. When both sides changed the same task, the copy with the newer updatedAt wins
   * and the other stays in history: the local commit is replayed as it was, then the remote copy
   * goes back on top in a commit of its own if it was the newer one. An edit beats a delete.
   */
  async function pullRebase(): Promise<void> {
    try {
      await git(clone, 'pull', '-q', '--rebase')
      return
    } catch (err) {
      if (!rebasing()) throw err
    }
    const upstream = new Map<string, string | null>()
    try {
      while (rebasing()) {
        const paths = (await git(clone, 'diff', '--name-only', '--diff-filter=U')).split('\n').filter(Boolean)
        if (!paths.length) throw Error('git stopped the rebase without a conflict')
        for (const path of paths) {
          // Mid-rebase, stage 2 is the remote side and stage 3 the local commit being replayed.
          if (!upstream.has(path)) upstream.set(path, await show(`:2:${path}`))
          const local = await show(`:3:${path}`)
          if (local === null) await git(clone, 'rm', '-q', '--', path)
          else {
            writeFileSync(join(clone, path), local)
            await git(clone, 'add', '--', path)
          }
        }
        await git(clone, 'rebase', '--continue').catch(err => { if (!rebasing()) throw err })
      }
    } catch (err) {
      await git(clone, 'rebase', '--abort').catch(() => {})
      throw err
    }
    const kept: string[] = []
    for (const [path, theirs] of upstream) {
      if (theirs === null) continue
      let mine: string | null = null
      try { mine = readFileSync(join(clone, path), 'utf8') } catch { /* deleted here */ }
      if (mine !== null && stamp(mine) >= stamp(theirs)) continue
      mkdirSync(dirname(join(clone, path)), { recursive: true })
      writeFileSync(join(clone, path), theirs)
      await git(clone, 'add', '--', path)
      kept.push(titleOf(theirs))
    }
    if (kept.length) await git(clone, 'commit', '-q', '-m', `${who()}: keep newer ${kept.join(', ')}`)
  }

  async function push(): Promise<void> {
    try {
      await git(clone, 'push', '-q', 'origin', 'HEAD')
    } catch {
      // Rejected because the other Mac pushed first: take its commits, then try once more.
      await pullRebase()
      await git(clone, 'push', '-q', 'origin', 'HEAD')
    }
  }

  /** Write task files, commit and push them. Once committed the change is safe: a failed push is retried by the next sync. */
  async function change(write: () => { paths: string[]; message: string } | null): Promise<void> {
    let committed = false
    await job(async () => {
      await ready()
      const done = write()
      if (!done) return
      await git(clone, 'add', '-A', '--', ...done.paths)
      // Nothing to commit when the files already say this (a task put back where it was).
      if (!(await git(clone, 'status', '--porcelain', '--', ...done.paths)).trim()) return
      await git(clone, 'commit', '-q', '-m', done.message)
      committed = true
      await push()
    }).catch(err => { if (!committed) throw err })
  }

  /** Several tasks in one go: a shared batch is one commit. Every input is checked before anything is written. */
  async function saveMany(scope: TaskScope, inputs: TaskInput[]): Promise<TaskList> {
    const user = who()
    if (!Array.isArray(inputs) || !inputs.length) throw Error('Nothing to save.')
    inputs.forEach(check)
    if (scope === 'personal') {
      const tasks = readPersonal(user)
      for (const input of inputs) {
        const at = input.id === undefined ? -1 : tasks.findIndex(task => task.id === input.id)
        if (input.id !== undefined && at < 0) throw Error('That task no longer exists.')
        const task = build(input, tasks[at], user)
        if (at < 0) tasks.push(task); else tasks[at] = task
      }
      writePersonal(user, tasks)
      return list()
    }
    // The old copies are read inside the job, after any sync that was already running.
    await change(() => {
      const made = inputs.map(input => {
        const old = input.id === undefined ? undefined : readTask(join(tasksDir, `${input.id}.json`))
        if (input.id !== undefined && !old) throw Error('That task no longer exists.')
        return { old, task: build(input, old, user) }
      })
      mkdirSync(tasksDir, { recursive: true })
      for (const { task } of made) writeFileSync(join(tasksDir, `${task.id}.json`), JSON.stringify(task, null, 2) + '\n', 'utf8')
      // A paste reassigns the tasks it moves and may renumber the ones around them.
      const verbs = [...new Set(made.map(({ old, task }) => verb(old, task)))], word = verbs.length === 1 ? verbs[0] : verbs.every(v => v === 'reorder' || v.startsWith('assign to')) ? 'move' : 'edit'
      return { paths: made.map(({ task }) => `tasks/${task.id}.json`), message: `${user}: ${word} ${titles(made.map(({ task }) => task))}` }
    })
    return list()
  }

  async function removeMany(scope: TaskScope, ids: string[]): Promise<TaskList> {
    if (!Array.isArray(ids) || !ids.length || !ids.every(validId)) throw Error('Invalid task id')
    const user = who()
    if (scope === 'personal') {
      writePersonal(user, readPersonal(user).filter(task => !ids.includes(task.id)))
      return list()
    }
    await change(() => {
      const gone = ids.flatMap(id => { const task = readTask(join(tasksDir, `${id}.json`)); return task ? [{ ...task, id }] : [] })
      if (!gone.length) return null
      for (const task of gone) rmSync(join(tasksDir, `${task.id}.json`), { force: true })
      return { paths: gone.map(task => `tasks/${task.id}.json`), message: `${user}: delete ${titles(gone)}` }
    })
    return list()
  }

  return {
    personalFile,
    tasksDir,
    list,

    sync(): Promise<TaskList> {
      // Nothing is cloned until someone has said who they are, so a fresh profile stays offline.
      const user = opts.user()
      if (!opts.remote || !user) return Promise.resolve(list())
      return job(async () => {
        if (await ready()) return
        const before = readShared(), waiting = new Set(unseen(user, before))
        await pullRebase()
        if ((await git(clone, 'rev-list', '--count', '@{u}..HEAD')).trim() !== '0') await push()
        // What came in from the other Mac: changes not waiting to be seen before, and tasks gone.
        const after = readShared(), now = new Set(after.map(task => task.id)), fresh = new Set(unseen(user, after))
        const changed = after.filter(task => fresh.has(task.id) && !waiting.has(task.id))
        const removed = before.filter(task => !now.has(task.id)).map(task => task.title)
        if (changed.length || removed.length) opts.notify?.({ by: user === 'livio' ? 'ilai' : 'livio', changed, removed })
      }).catch(() => {}).then(list)
    },

    /** The person on this Mac has looked at these shared tasks as they are now. */
    markSeen(ids: string[]): TaskList {
      const user = who()
      const seen = readSeen(user) ?? {}
      for (const task of readShared()) if (ids.includes(task.id)) seen[task.id] = task.updatedAt
      writeSeen(user, seen)
      // The To-do button's dot counts the unseen ones too.
      opts.changed()
      return list()
    },

    /** Every version of a shared task, newest first, from the repo's history. */
    async history(id: string): Promise<TaskVersion[]> {
      if (!validId(id)) throw Error('Invalid task id')
      if (!existsSync(join(clone, '.git'))) return []
      const log = await git(clone, 'log', '-n', '60', '--format=%H%x1f%aI%x1f%s', '--', `tasks/${id}.json`)
      const versions: TaskVersion[] = []
      for (const line of log.split('\n').filter(Boolean)) {
        const [hash, at, message] = line.split('\x1f')
        let task: Task | null = null
        try { const json = await show(`${hash}:tasks/${id}.json`); task = json ? clean(JSON.parse(json)) : null } catch {}
        versions.push({ hash, at, message, by: task?.updatedBy ?? message.split(':')[0], task })
      }
      return versions
    },

    save: (scope: TaskScope, input: TaskInput): Promise<TaskList> => saveMany(scope, [input]),
    saveMany,
    remove: (scope: TaskScope, id: string): Promise<TaskList> => removeMany(scope, [id]),
    removeMany,

    /**
     * Puts tasks back exactly as they were, for undo: same id, dates and authors, written the way save
     * writes them. A shared batch is one commit.
     */
    async restore(scope: TaskScope, tasks: Task[]): Promise<TaskList> {
      if (!Array.isArray(tasks) || !tasks.length) throw Error('Nothing to restore.')
      for (const task of tasks) {
        if (!task || typeof task !== 'object' || !validId(task.id) || !STATUSES.includes(task.status) || task.assignee === undefined) throw Error('Invalid task')
        if (!(['title', 'notes', 'product', 'createdAt', 'createdBy', 'updatedAt', 'updatedBy'] as const).every(field => typeof task[field] === 'string')) throw Error('Invalid task')
        check({ title: task.title, notes: task.notes, status: task.status, assignee: task.assignee, product: task.product, order: task.order })
      }
      const user = who(), back = tasks.map(clean)
      if (scope === 'personal') {
        const have = readPersonal(user), ids = new Set(have.map(task => task.id))
        writePersonal(user, [...have.map(task => back.find(t => t.id === task.id) ?? task), ...back.filter(task => !ids.has(task.id))])
        return list()
      }
      await change(() => {
        mkdirSync(tasksDir, { recursive: true })
        for (const task of back) writeFileSync(join(tasksDir, `${task.id}.json`), JSON.stringify(task, null, 2) + '\n', 'utf8')
        return { paths: back.map(task => `tasks/${task.id}.json`), message: `${user}: restore ${titles(back)}` }
      })
      return list()
    },

    /**
     * Private to shared (assigned to `assignee`, by default the user) or shared to private, keeping
     * the id and dates; `order` places it in the list it goes to. The task is written where it goes
     * before it leaves where it was, and a step that fails puts back what it changed: a failed move
     * leaves the task where it was, never nowhere.
     */
    async move(from: TaskScope, id: string, assignee?: Task['assignee'], order?: number): Promise<TaskList> {
      if (!validId(id)) throw Error('Invalid task id')
      if (assignee !== undefined && assignee !== null && !ASSIGNEES.includes(assignee)) throw Error('Invalid assignee')
      if (order !== undefined && !Number.isFinite(order)) throw Error('Invalid order')
      const placed = order === undefined ? {} : { order }
      const user = who(), file = join(tasksDir, `${id}.json`), path = `tasks/${id}.json`
      // Set inside the git job; `as` keeps TypeScript from treating them as never assigned.
      let before = undefined as string | null | undefined, added = false as boolean
      if (from === 'personal') {
        const task = readPersonal(user).find(t => t.id === id)
        if (!task) throw Error('That task no longer exists.')
        try {
          await change(() => {
            before = existsSync(file) ? readFileSync(file, 'utf8') : null
            mkdirSync(tasksDir, { recursive: true })
            writeFileSync(file, JSON.stringify(clean({ ...task, ...placed, assignee: assignee === undefined ? user : assignee, updatedAt: romeIso(), updatedBy: user }), null, 2) + '\n', 'utf8')
            return { paths: [path], message: `${user}: share ${task.title}` }
          })
        } catch (err) {
          // Not committed: the next sync would commit the copy while the task is still private.
          if (before === null) rmSync(file, { force: true })
          else if (before !== undefined) writeFileSync(file, before)
          throw err
        }
        writePersonal(user, readPersonal(user).filter(t => t.id !== id))
        return list()
      }
      try {
        await change(() => {
          const old = readTask(file)
          if (!old) throw Error('That task no longer exists.')
          before = readFileSync(file, 'utf8')
          writePersonal(user, [...readPersonal(user).filter(t => t.id !== id), clean({ ...old, ...placed, assignee: null, updatedAt: romeIso(), updatedBy: user })])
          added = true
          rmSync(file)
          return { paths: [path], message: `${user}: make private ${old.title}` }
        })
      } catch (err) {
        // Not committed: the next sync would commit the delete as "save unsynced changes".
        if (typeof before === 'string' && !existsSync(file)) writeFileSync(file, before)
        if (added) writePersonal(user, readPersonal(user).filter(t => t.id !== id))
        throw err
      }
      return list()
    },
  }
}
