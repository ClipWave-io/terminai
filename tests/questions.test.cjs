// detectQuestion() against real screenshots of each prompt a tab can stop on
// (src/shared/questions.ts). Fixtures are `terminai read` of a live prompt, one
// file per kind, plus negatives — including a tab that merely echoed the prompt
// words and is back at its bare "❯" input box.
const { buildSync } = require('esbuild'), assert = require('assert/strict'), os = require('os'), path = require('path'), fs = require('fs')

const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'questions-')), 'q.cjs')
buildSync({ entryPoints: [path.join(__dirname, '../src/shared/questions.ts')], outfile: out, format: 'cjs', bundle: true, platform: 'node', logLevel: 'error' })
const { detectQuestion } = require(out)

const fx = name => fs.readFileSync(path.join(__dirname, 'fixtures/questions', name), 'utf8').split('\n')

const positive = { 'trust.txt': 'trust', 'permission.txt': 'permission', 'plan.txt': 'plan', 'askquestion.txt': 'question' }
for (const [file, kind] of Object.entries(positive))
  assert.equal(detectQuestion(fx(file)), kind, `${file} should be ${kind}`)

const negative = ['neg-idle.txt', 'neg-working.txt', 'neg-echo-permission.txt', 'neg-echo-self.txt']
for (const file of negative)
  assert.equal(detectQuestion(fx(file)), null, `${file} should not read as a question`)

// The gate is the last non-blank line, so order and padding around it do not matter.
assert.equal(detectQuestion([' ❯ 2. Yes, and don\'t ask again', '']), 'question', 'trailing blank lines are skipped')
assert.equal(detectQuestion(['❯ Yes, I trust this folder']), 'trust', 'arrowed onto the trust option')
assert.equal(detectQuestion([]), null, 'empty screen')
assert.equal(detectQuestion(['❯']), null, 'bare input box')

console.log(`PASS questions: ${Object.keys(positive).length} kinds, ${negative.length} negatives, 4 cases`)
