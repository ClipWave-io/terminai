import { chmodSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * What a coding agent on this Mac needs to know about TerminAI, written at every start into the
 * user's global instructions for Claude Code (~/.claude/CLAUDE.md) and Codex (~/.codex/AGENTS.md),
 * so the `terminai` commands travel with the app instead of living in one person's notes.
 */
export const AGENT_GUIDE = `## TerminAI
This Mac runs TerminAI, a terminal app whose tabs run Claude Code and Codex sessions. Its \`terminai\` command works in every TerminAI tab and prints JSON.
- "Open or run something in the terminal", "start a session that does X": a TerminAI tab, \`terminai open --cwd "$PWD" --name <name> -- <command>\`. It starts in the background without taking the user's view. Keep the command short: hand a long prompt over as a file path, never inline. Never Terminal.app, iTerm or osascript.
- "Open/show me file X" (any kind: PDF, Word, Excel, Pages, images including HEIC, video, audio, text, code): \`terminai show <absolute path>\` opens it in TerminAI's Files pane beside the chat. Another app only when the user asks for it.
- The team's tasks are TerminAI's To-do, shared with the partner plus each person's private list: \`terminai todo --shared\` (read-only JSON; also \`--open\`, \`--mine\`, \`--personal\`), in the order of the \`order\` field. Read them there, not in note apps or older boards; changes are made in the app.
- Other tabs: \`terminai list\`, \`terminai send <id> <text>\`, \`terminai read <id>\`, \`terminai focus <id>\`, \`terminai close <id>\`.
- If \`terminai\` is missing or does not answer (no \`$TERMINAI_CONTROL\`), say so instead of falling back to another app.`

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
