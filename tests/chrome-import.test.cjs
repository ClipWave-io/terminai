// Import from Chrome: values encrypted with Chrome's key come out encrypted with Chromium's (src/main/chrome-import.ts).
// Run: npx esbuild src/main/chrome-import.ts --bundle --platform=node --format=cjs --outfile=.chrome-import.cjs && node --test tests/chrome-import.test.cjs
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto'), { execFileSync } = require('node:child_process')
const { keyFrom, copyTable } = require(path.join(__dirname, '..', '.chrome-import.cjs'))
const IV = Buffer.alloc(16, ' ')
const enc = (key, text) => { const c = crypto.createCipheriv('aes-128-cbc', key, IV); return Buffer.concat([Buffer.from('v10'), c.update(text), c.final()]) }
const dec = (key, blob) => { const d = crypto.createDecipheriv('aes-128-cbc', key, IV); return Buffer.concat([d.update(blob.subarray(3)), d.final()]).toString() }
test('cookies re-encrypted with the browser key', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'imp-')), src = path.join(dir, 'Cookies'), dst = path.join(dir, 'out', 'Cookies')
  fs.mkdirSync(path.dirname(dst))
  const chrome = keyFrom('chrome-secret'), chromium = keyFrom('chromium-secret')
  execFileSync('/usr/bin/sqlite3', [src, `create table cookies(host_key text, encrypted_value blob); insert into cookies values ('a.com', X'${enc(chrome, 'session=abc').toString('hex')}'), ('b.com', X'${enc(chrome, 'id=42').toString('hex')}');`])
  const n = await copyTable(src, dst, 'cookies', 'encrypted_value', chrome, chromium)
  assert.equal(n, 2)
  const rows = execFileSync('/usr/bin/sqlite3', [dst, 'select host_key, hex(encrypted_value) from cookies order by host_key']).toString().trim().split('\n').map(r => r.split('|'))
  assert.deepEqual(rows.map(([h, x]) => [h, dec(chromium, Buffer.from(x, 'hex'))]), [['a.com', 'session=abc'], ['b.com', 'id=42']])
})
