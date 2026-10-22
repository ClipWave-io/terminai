// The TerminAI section of the agents' global instructions (src/main/agent-guide.ts).
// Run: npx esbuild src/main/agent-guide.ts --bundle --platform=node --format=cjs --outfile=.agent-guide.cjs && node --test tests/agent-guide.test.cjs
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const { writeAgentGuide, AGENT_GUIDE, agentGuide, todoMap } = require(path.join(__dirname, '..', '.agent-guide.cjs'))
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

test('the map of the To-do pages goes under the guide, private lists with what they are for', () => {
  const map = todoMap('livio', [{ id: 'private', name: 'General' }, { id: 'x1', name: 'Unlocked Tour', about: 'Barcelona tour agency' }])
  assert.match(map, /you work with Matteo \(`livio`\)/)
  assert.match(map, /the columns Matteo, Together, Ilai and Unassigned/)
  assert.match(map, /Private lists, only on this Mac: "General" \(the first one\): no description yet; "Unlocked Tour": Barcelona tour agency\./)
  assert.equal(todoMap('', []), '', 'nobody chosen yet: no map')
  const f = path.join(tmp(), 'CLAUDE.md')
  writeAgentGuide(f, agentGuide(map))
  const s = fs.readFileSync(f, 'utf8')
  assert.ok(s.includes(AGENT_GUIDE + '\n' + map + '\n<!-- END TERMINAI -->'))
  // A list renamed: the same section, rewritten.
  writeAgentGuide(f, agentGuide(todoMap('livio', [{ id: 'private', name: 'General' }, { id: 'x1', name: 'Agency' }])))
  assert.equal(fs.readFileSync(f, 'utf8').split('<!-- BEGIN TERMINAI').length, 2)
  assert.match(fs.readFileSync(f, 'utf8'), /"Agency": no description yet\./)
})
