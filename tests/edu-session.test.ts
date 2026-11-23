import { test } from 'node:test'
import assert from 'node:assert/strict'
import { activeMinutes, forDetail, inFolders, isFinished, patchFiles, readClaudeSession, readCodexSession, relativeFile } from '../src/main/edu-session'

const cwd = '/Users/ada/courses/cs101/assignment-3'
const t = (m: number) => new Date(Date.UTC(2026, 10, 23, 10, m)).toISOString()
const claude = [
  { type: 'ai-title', aiTitle: 'Fix the parser' },
  { type: 'user', timestamp: t(0), cwd, message: { content: 'Why does parse() fail on empty lines?' } },
  { type: 'assistant', timestamp: t(1), cwd, message: { content: [{ type: 'text', text: 'The loop is off by one.' }, { type: 'tool_use', name: 'Edit', input: { file_path: `${cwd}/src/parse.py` } }] } },
  { type: 'user', timestamp: t(2), cwd, message: { content: [{ type: 'tool_result', content: 'ok' }] } },
  { type: 'user', timestamp: t(4), cwd, message: { content: '<command-name>/clear</command-name>' } },
  { type: 'user', timestamp: t(6), cwd, message: { content: [{ type: 'text', text: 'Add a test for it' }] } },
  { type: 'assistant', timestamp: t(8), cwd, message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: `${cwd}/tests/test_parse.py` } }, { type: 'text', text: 'Added tests/test_parse.py.' }] } },
  { type: 'assistant', timestamp: t(40), cwd, message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/etc/hosts' } }] } },
].map(x => JSON.stringify(x))

test('reads a Claude Code session: prompts, replies, files, active time', () => {
  const s = readClaudeSession('abc', claude)!
  assert.equal(s.tool, 'claude-code'); assert.equal(s.externalId, 'claude-code:abc'); assert.equal(s.title, 'Fix the parser')
  assert.equal(s.project, 'assignment-3'); assert.equal(s.prompts, 2); assert.equal(s.replies, 2)
  assert.deepEqual(s.filesTouched, ['src/parse.py', 'tests/test_parse.py'])
  assert.equal(s.activeMinutes, 8)                     // the 32-minute pause does not count
  assert.equal(s.startedAt, t(0)); assert.equal(s.endedAt, t(40))
})

test('only what the institution collects leaves the Mac', () => {
  const s = readClaudeSession('abc', claude)!
  assert.equal(forDetail(s, 'summary').turns.length, 0)
  assert.deepEqual(forDetail(s, 'prompts').turns.map(x => x.role), ['user', 'user'])
  assert.equal(forDetail(s, 'full').turns.length, 4)
  assert.equal('cwd' in forDetail(s, 'full'), false)   // the full path never leaves
})

test('reads a Codex session with apply_patch files', () => {
  const lines = [
    { type: 'session_meta', timestamp: t(0), payload: { cwd } },
    { type: 'response_item', timestamp: t(0), payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>…</environment_context>' }] } },
    { type: 'response_item', timestamp: t(1), payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Refactor the tokenizer' }] } },
    { type: 'response_item', timestamp: t(2), payload: { type: 'function_call', name: 'shell', arguments: JSON.stringify({ command: ['apply_patch', '*** Begin Patch\n*** Update File: src/tokenize.py\n@@\n*** Add File: src/util.py\n*** End Patch'] }) } },
    { type: 'response_item', timestamp: t(3), payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done.' }] } },
  ].map(x => JSON.stringify(x))
  const s = readCodexSession('rollout-1', lines)!
  assert.equal(s.tool, 'codex'); assert.equal(s.prompts, 1); assert.equal(s.replies, 1)
  assert.deepEqual(s.filesTouched, ['src/tokenize.py', 'src/util.py'])
  assert.equal(s.title, 'Refactor the tokenizer')
})

test('helpers', () => {
  assert.deepEqual(patchFiles('*** Delete File: a.py\n*** Update File: b/c.py'), ['a.py', 'b/c.py'])
  assert.equal(relativeFile('/Users/ada/x/y.py', '/Users/ada/x'), 'y.py')
  assert.equal(relativeFile('/etc/hosts', '/Users/ada/x'), 'hosts')
  assert.equal(inFolders(cwd, ['/Users/ada/courses']), true)
  assert.equal(inFolders('/Users/ada/courses-old', ['/Users/ada/courses']), false)
  assert.equal(isFinished(0, 9 * 60_000), false); assert.equal(isFinished(0, 10 * 60_000), true)
  assert.equal(activeMinutes([0, 60_000, 10 * 60_000]), 1)
  assert.equal(readClaudeSession('x', [JSON.stringify({ type: 'assistant', timestamp: t(0), message: { content: [{ type: 'text', text: 'hi' }] } })]), null)
})
