/**
 * A tab is "asking" when its agent (Claude Code or Codex) has stopped on an
 * interactive prompt and is waiting for an answer: a multiple-choice question
 * (AskUserQuestion), a tool-permission prompt, the folder trust check, or a plan
 * to approve. Timing and the bell cannot tell these apart from ordinary idle or
 * work — the prompt is a specific screen — so detection reads the rendered tail
 * of the terminal (xterm's own buffer), not the raw byte stream, whose absolute
 * cursor moves drop the spaces between words.
 *
 * Recognised from screenshots of each kind under tests/fixtures/questions.
 */
export type QuestionKind = 'trust' | 'permission' | 'plan' | 'question'

/** The selected option of a Claude/Codex picker: "❯ 1." / "❯ 2." etc. The input
 * box is "❯" alone or "❯ <typed text>"; it never carries a digit-dot. */
const POINTER_NUM = /^\s*[❯>]\s*\d+\.\s/
/** The folder-trust check points at bare words, with no number. */
const POINTER_TRUST = /^\s*[❯>]\s*(No, exit|Yes, I trust this folder)\s*$/

/**
 * The kind of question the tab is stopped on, or null when it is not. `lines` is
 * the rendered tail of the screen (most recent last), as `snapshots.snapshot(id,
 * n)` returns it; ~30 lines reaches the question phrase above the option.
 *
 * The gate is the *last non-blank line*: when the agent parks on a picker the
 * cursor sits on the selected option, so that line is a pointer. An answer the
 * agent merely printed, or the same words quoted in a conversation, scrolls up
 * and the tab ends back on its bare "❯" input box — which is why matching any
 * line (as a first cut did, and as swap.sh once did) misreads an echo as a live
 * question. Phrases only classify a gate that already passed.
 */
export function detectQuestion(lines: string[]): QuestionKind | null {
  let last = lines.length - 1
  while (last >= 0 && !lines[last].trim()) last--
  if (last < 0) return null
  const tail = lines[last]

  if (POINTER_TRUST.test(tail)) return 'trust'
  if (!POINTER_NUM.test(tail)) return null

  // On a numbered picker: classify by the phrasing above the option. The folder
  // trust check also shows a number once you arrow onto "Yes, I trust…".
  const text = lines.join('\n')
  if (/Quick safety check|Do you trust the files in this folder/.test(text)) return 'trust'
  if (/Would you like to proceed\?|No, keep planning|written up a plan|Here is Claude's plan|Ready to code\?/.test(text)) return 'plan'
  if (/Do you want to proceed\?/.test(text)) return 'permission'
  // AskUserQuestion, and any other agent prompt — a Codex approval included —
  // so the tab still flags even for a shape we have not catalogued.
  return 'question'
}
