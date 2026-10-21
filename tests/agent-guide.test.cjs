// The TerminAI section of the agents' global instructions (src/main/agent-guide.ts).
// Run: npx esbuild src/main/agent-guide.ts --bundle --platform=node --format=cjs --outfile=.agent-guide.cjs && node --test tests/agent-guide.test.cjs
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const { writeAgentGuide, AGENT_GUIDE } = require(path.join(__dirname, '..', '.agent-guide.cjs'))
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'terminai-guide-'))

test('a missing file is created with the section only', () => {
  const f = path.join(tmp(), 'sub', 'CLAUDE.md')
  assert.equal(writeAgentGuide(f), true)
  const s = fs.readFileSync(f, 'utf8')
  assert.match(s, /^<!-- BEGIN TERMINAI[^\n]*-->\n## TerminAI\n/)
  assert.ok(s.endsWith('<!-- END TERMINAI -->\n'))
})

test('the user\'s own instructions stay as they were, the section goes at the end once', () => {
  const f = path.join(tmp(), 'CLAUDE.md'), mine = '# Mine\n- rule one\n@~/.claude/FABLE.md'
  fs.writeFileSync(f, mine, { mode: 0o600 })
  assert.equal(writeAgentGuide(f), true)
  const s = fs.readFileSync(f, 'utf8')
  assert.ok(s.startsWith(mine + '\n\n<!-- BEGIN TERMINAI'))
  assert.equal(s.split('<!-- BEGIN TERMINAI').length, 2)
  assert.equal(fs.statSync(f).mode & 0o777, 0o600, 'the file keeps its permissions')
  assert.equal(writeAgentGuide(f), false, 'a second start changes nothing')
  assert.equal(fs.readFileSync(f, 'utf8'), s)
})

test('a new version replaces only its own section', () => {
  const f = path.join(tmp(), 'AGENTS.md')
  fs.writeFileSync(f, 'before\n')
  writeAgentGuide(f, '## TerminAI\nold text')
  fs.appendFileSync(f, '\nafter, added by the user\n')
  assert.equal(writeAgentGuide(f), true)
  const s = fs.readFileSync(f, 'utf8')
  assert.ok(s.startsWith('before\n\n<!-- BEGIN TERMINAI'))
  assert.ok(s.endsWith('<!-- END TERMINAI -->\n\nafter, added by the user\n'))
  assert.ok(s.includes(AGENT_GUIDE) && !s.includes('old text'))
})

test('a damaged section is left alone', () => {
  const f = path.join(tmp(), 'CLAUDE.md'), body = 'x\n<!-- BEGIN TERMINAI (written by the TerminAI app at every start: edits inside are replaced) -->\nhalf'
  fs.writeFileSync(f, body)
  assert.throws(() => writeAgentGuide(f), /Incomplete TerminAI section/)
  assert.equal(fs.readFileSync(f, 'utf8'), body)
})
