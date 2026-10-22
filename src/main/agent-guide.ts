import { chmodSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { DEFAULT_LIST } from '../shared/types'
import type { TaskListPage } from '../shared/types'

/**
 * What a coding agent on this Mac needs to know about TerminAI, written at every start into the
 * user's global instructions for Claude Code (~/.claude/CLAUDE.md) and Codex (~/.codex/AGENTS.md),
 * so the `terminai` commands travel with the app instead of living in one person's notes.
 */
export const AGENT_GUIDE = `## TerminAI
This Mac runs TerminAI, a terminal app whose tabs run Claude Code and Codex sessions. Its \`terminai\` command works in every TerminAI tab and prints JSON.
- "Open or run something in the terminal", "start a session that does X": a TerminAI tab, \`terminai open --cwd "$PWD" --name <name> -- <command>\`. It starts in the background without taking the user's view. Keep the command short: hand a long prompt over as a file path, never inline. Never Terminal.app, iTerm or osascript.
- "Open/show me file X" (any kind: PDF, Word, Excel, Pages, images including HEIC, video, audio, text, code): \`terminai show <absolute path>\` opens it in TerminAI's Files pane beside the chat. Another app only when the user asks for it.
- The team's tasks are TerminAI's To-do, in pages. The shared page has a column for each partner, Together and Unassigned; both partners see it. Each private list is a page of its own, only on this Mac, with a description of what it is for. When the user talks about a task ("look at task D", "add D here"), first run \`terminai todo map\`: every page with its description and its open tasks in order, so you know which task and which page are meant. \`terminai todo --shared\` (also \`--open\`, \`--mine\`, \`--personal\`) is the full read-only JSON: a private task's \`list\` names its list, \`imageFiles\` are the screenshots and photos under a task's note (look at them when they matter), \`session\` is the tab of this Mac working on it. Read the tasks there, not in note apps or older boards.
- Adding: \`terminai todo add <title> --to <page> [--note <text>]\`, the page being matteo, together, ilai, unassigned or a private list's name. "Here" is the private list whose description fits the project you are working in, or the page the user is talking about; when that is not clear, ask before adding. A shared page is seen by the partner, a private list never leaves this Mac. When the user says what a private list is for: \`terminai todo about <list> <text>\`.
- When the user says you are starting a task of the To-do ("let's start X", "we're working on X"), run \`terminai todo start <id or title>\`: it shows in progress to both partners, and on this Mac only it links the task to your tab. When it is finished, \`terminai todo done <id>\`; \`terminai todo reopen <id>\` takes it back. Only the user's own, Together and private tasks; any other change is made in the app.
- Other tabs: \`terminai list\`, \`terminai send <id> <text>\`, \`terminai read <id>\`, \`terminai focus <id>\`, \`terminai close <id>\`.
- If \`terminai\` is missing or does not answer (no \`$TERMINAI_CONTROL\`), say so instead of falling back to another app.`

/**
 * This Mac's To-do pages as they are now, a line under the guide: a session knows which list "here" is without
 * asking the app first. The app writes it again when a list is made, renamed, described or deleted.
 */
export function todoMap(user: string, lists: TaskListPage[]): string {
  if (user !== 'livio' && user !== 'ilai') return ''
  const me = user === 'livio' ? 'Matteo' : 'Ilai', other = user === 'livio' ? 'Ilai' : 'Matteo'
  const pages = lists.map(page => `"${page.name}"${page.id === DEFAULT_LIST ? ' (the first one)' : ''}: ${page.about ?? 'no description yet'}`).join('; ')
  return `- This Mac's To-do now (rewritten by the app when the lists change; \`terminai todo map\` has the tasks): you work with ${me} (\`${user}\`). The shared page, which ${other} sees too: the columns ${me}, Together, ${other} and Unassigned. Private lists, only on this Mac: ${pages}.`
}
export const agentGuide = (map = '') => map ? `${AGENT_GUIDE}\n${map}` : AGENT_GUIDE

const START = '<!-- BEGIN TERMINAI (written by the TerminAI app at every start: edits inside are replaced) -->'
const END = '<!-- END TERMINAI -->'

/** Puts the guide in its own section of an instructions file, leaving everything else as it is. */
export function writeAgentGuide(file: string, guide = AGENT_GUIDE): boolean {
  let original = ''
  try { original = readFileSync(file, 'utf8') } catch (e: any) { if (e.code !== 'ENOENT') throw e }
  const first = original.indexOf(START), last = original.indexOf(END)
  if ((first >= 0) !== (last >= 0) || last < first) throw Error(`Incomplete TerminAI section in ${file}`)
  const section = `${START}\n${guide}\n${END}`
  const updated = first >= 0 ? original.slice(0, first) + section + original.slice(last + END.length)
    : `${original}${original && !original.endsWith('\n') ? '\n' : ''}${original ? '\n' : ''}${section}\n`
  if (updated === original) return false
  let mode = 0o644
  try { mode = statSync(file).mode & 0o777 } catch {}
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(`${file}.terminai-tmp`, updated, { mode })
  chmodSync(`${file}.terminai-tmp`, mode)
  renameSync(`${file}.terminai-tmp`, file)
  return true
}
