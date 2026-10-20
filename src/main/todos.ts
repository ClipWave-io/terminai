import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Task, TaskInput, TaskList, TaskScope, TasksSync, TasksUser } from '../shared/types'

/**
 * The To-do sheet's data. Personal tasks are one JSON file in userData and never leave the Mac.
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

export function createTodos(dir: string, opts: { remote: string; user: () => TasksUser | ''; changed: () => void }) {
  const personalFile = join(dir, 'todos-personal.json')
  const clone = join(dir, 'build-tasks')
  const tasksDir = join(clone, 'tasks')
  const status: TasksSync = { enabled: Boolean(opts.remote), syncing: false, lastSync: null, error: opts.remote ? null : 'No shared repository is set for this build.' }

  function readPersonal(): Task[] {
    try { const list = JSON.parse(readFileSync(personalFile, 'utf8')); return Array.isArray(list) ? list : [] } catch { return [] }
  }
  function writePersonal(list: Task[]): void {
    // Write-then-rename, as store.ts does for prefs.
    const tmp = `${personalFile}.tmp`
    writeFileSync(tmp, JSON.stringify(list, null, 2) + '\n', 'utf8')
    renameSync(tmp, personalFile)
  }
  function readTask(file: string): Task | undefined {
    try { const task = JSON.parse(readFileSync(file, 'utf8')); return task && typeof task === 'object' ? task : undefined } catch { return undefined }
  }
  function readShared(): Task[] {
    let names: string[] = []
    try { names = readdirSync(tasksDir).filter(name => name.endsWith('.json')) } catch { return [] }
    return names.flatMap(name => readTask(join(tasksDir, name)) ?? [])
  }
  const list = (): TaskList => ({ personal: readPersonal(), shared: readShared(), sync: { ...status } })

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
  }
  function build(input: TaskInput, old: Task | undefined, user: TasksUser): Task {
    const now = romeIso()
    return {
      id: old?.id ?? randomUUID(),
      title: input.title?.trim() ?? old?.title ?? '',
      notes: input.notes?.trim() ?? old?.notes ?? '',
      status: input.status ?? old?.status ?? 'open',
      assignee: input.assignee === undefined ? old?.assignee ?? null : input.assignee,
      product: input.product?.trim() ?? old?.product ?? '',
      createdAt: old?.createdAt ?? now, createdBy: old?.createdBy ?? user, updatedAt: now, updatedBy: user,
    }
  }
  /** The verb in the commit message, e.g. "livio: done Fix login". */
  function verb(old: Task | undefined, next: Task): string {
    if (!old) return 'add'
    if (old.status !== next.status) return next.status === 'done' ? 'done' : next.status === 'doing' ? 'start' : 'reopen'
    if (old.assignee !== next.assignee) return `assign to ${next.assignee ?? 'nobody'}`
    return 'edit'
  }

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

  /** Write one task file, commit and push it. Once committed the change is safe: a failed push is retried by the next sync. */
  async function change(write: () => { path: string; message: string } | null): Promise<void> {
    let committed = false
    await job(async () => {
      await ready()
      const done = write()
      if (!done) return
      await git(clone, 'add', '-A', '--', done.path)
      await git(clone, 'commit', '-q', '-m', done.message)
      committed = true
      await push()
    }).catch(err => { if (!committed) throw err })
  }

  return {
    personalFile,
    tasksDir,
    list,

    sync(): Promise<TaskList> {
      // Nothing is cloned until someone has said who they are, so a fresh profile stays offline.
      if (!opts.remote || !opts.user()) return Promise.resolve(list())
      return job(async () => {
        if (await ready()) return
        await pullRebase()
        if ((await git(clone, 'rev-list', '--count', '@{u}..HEAD')).trim() !== '0') await push()
      }).catch(() => {}).then(list)
    },

    async save(scope: TaskScope, input: TaskInput): Promise<TaskList> {
      const user = who()
      check(input)
      if (scope === 'personal') {
        const tasks = readPersonal(), at = input.id === undefined ? -1 : tasks.findIndex(task => task.id === input.id)
        if (input.id !== undefined && at < 0) throw Error('That task no longer exists.')
        const task = build(input, tasks[at], user)
        if (at < 0) tasks.push(task); else tasks[at] = task
        writePersonal(tasks)
        return list()
      }
      // The old copy is read inside the job, after any sync that was already running.
      await change(() => {
        const old = input.id === undefined ? undefined : readTask(join(tasksDir, `${input.id}.json`))
        if (input.id !== undefined && !old) throw Error('That task no longer exists.')
        const task = build(input, old, user)
        mkdirSync(tasksDir, { recursive: true })
        writeFileSync(join(tasksDir, `${task.id}.json`), JSON.stringify(task, null, 2) + '\n', 'utf8')
        return { path: `tasks/${task.id}.json`, message: `${user}: ${verb(old, task)} ${task.title}` }
      })
      return list()
    },

    async remove(scope: TaskScope, id: string): Promise<TaskList> {
      if (!validId(id)) throw Error('Invalid task id')
      if (scope === 'personal') {
        writePersonal(readPersonal().filter(task => task.id !== id))
        return list()
      }
      const user = who()
      await change(() => {
        const file = join(tasksDir, `${id}.json`), old = readTask(file)
        if (!old) return null
        rmSync(file, { force: true })
        return { path: `tasks/${id}.json`, message: `${user}: delete ${old.title}` }
      })
      return list()
    },
  }
}
