// The answer Claude Code is writing, read off the terminal screen for the Clean view (src/renderer/find.ts).
// Run: npx esbuild src/renderer/find.ts --bundle --platform=node --format=cjs --outfile=.find.cjs && node --test tests/streaming-answer.test.cjs
const test = require('node:test'), assert = require('node:assert/strict'), path = require('node:path')
const { streamingAnswer } = require(path.join(__dirname, '..', '.find.cjs'))
const box = ['─────────', '❯ ', '─────────']
test('the text block being written, wrapped lines joined, list kept', () => {
  assert.equal(streamingAnswer(['⏺ Bash(ls)', '  ⎿  ok', '', '⏺ Here is the answer so far, it is a long line that wraps around because the terminal is narrow and', '  Claude Code breaks it itself at the width.', '', '  - first point', '  - second', '', '✳ Channeling… (19s)', '  ⎿  Tip: x', '', ...box]),
    'Here is the answer so far, it is a long line that wraps around because the terminal is narrow and Claude Code breaks it itself at the width.\n\n- first point\n- second')
})
test('nothing while a tool runs', () => {
  assert.equal(streamingAnswer(['⏺ text done', '', '⏺ Bash(ls)', '  ⎿  Running…', '', '✳ Channeling…', ...box]), '')
})
