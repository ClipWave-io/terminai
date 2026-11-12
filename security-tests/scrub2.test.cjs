const esbuild = require(process.argv[2] + '/node_modules/esbuild'), path = require('path')
const fake = { name: 'fake', setup(b) { b.onResolve({ filter: /^\.\/store$/ }, () => ({ path: 'store', namespace: 'fake' })); b.onLoad({ filter: /.*/, namespace: 'fake' }, () => ({ contents: 'module.exports={load:()=>({}),save:()=>({})}', loader: 'js' })) } }
;(async () => {
  const r = await esbuild.build({ entryPoints: [path.join(process.argv[2], 'src/main/sharing.ts')], bundle: true, platform: 'node', format: 'cjs', write: false, plugins: [fake], external: ['electron'] })
  const m = { exports: {} }; new Function('module', 'exports', 'require', r.outputFiles[0].text)(m, m.exports, require)
  const R = (n) => Array.from({ length: n }, (_, i) => 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'[(i * 7 + 3) % 62]).join('')
  // All values below are made up in the real formats; none is a real credential.
  const cases = [
    ['OpenAI/Anthropic sk-', 'key sk-' + R(40)],
    ['GitHub ghp_', 'ghp_' + R(36)],
    ['password labelled EN', 'password: hunter2'],
    ['password labelled IT', 'la password è hunter2'],
    ['password after the value', 'hunter2 è la password del server'],
    ['Google API key AIza (39 chars)', 'AIza' + R(35)],
    ['Stripe webhook whsec_ (38)', 'whsec_' + R(32)],
    ['Stripe sk_live_', 'sk_live_' + R(99)],
    ['Resend re_ (36)', 're_' + R(33)],
    ['Mollie live_ (35)', 'live_' + R(30)],
    ['UUID token (Railway style)', '3f2b8c1e-7a4d-4e9b-8f21-6c5d4e3f2a1b'],
    ['Postgres URL with password', 'postgresql://postgres:Ab12Cd34Ef@db.internal:5432/app'],
    ['Bearer short', 'Authorization: Bearer ' + R(32)],
    ['Telegram bot token', '123456789:' + R(35)],
    ['Hetzner 64 chars', R(64)],
    ['6-digit code IT', 'il codice è 482913'],
    ['card number', '4242 4242 4242 4242 exp 12/29 cvc 123'],
    ['ssh/basic auth in URL', 'https://admin:S3cretPw@example.com/path'],
    ['env line', 'CRON_SECRET=Zx9Kq2Lm8Tt4'],
    ['env line API_KEY', 'RESEND_API_KEY=' + 're_' + R(33)],
    ['TerminAI bot key', 'tbot_' + R(43)],
    ['Stripe restricted rk_live_', 'rk_live_' + R(24)],
  ]
  // Must stay readable: none of these is a secret.
  const keep = [
    ['resume with a session id', 'claude --resume 3f2b8c1e-7a4d-4e9b-8f21-6c5d4e3f2a1b'],
    ['URL without credentials', 'https://example.com/docs/page?x=1&y=2'],
    ['a sentence about tokens', 'the token count was 1200 and the key idea is caching'],
    ['a phone number', 'chiamami al 601 507 841 domani'],
    ['an order number 16 digits (not Luhn)', 'ordine 1234567890123456 spedito'],
    ['a timestamp', '2026-11-10T14:21:24.682Z at 14:21'],
    ['an email address', 'scrivi a info@example.com'],
  ]
  let leaks = 0, mangled = 0
  const expectedLeak = new Set(['password after the value', 'UUID token (Railway style)'])
  for (const [name, text] of cases) { const out = m.exports.scrub(text), through = out === text; if (through && !expectedLeak.has(name)) leaks++; console.log((through ? 'PASSES THROUGH ' : 'hidden         ') + name.padEnd(34) + ' -> ' + out.slice(0, 64)) }
  for (const [name, text] of keep) { const out = m.exports.scrub(text), same = out === text; if (!same) mangled++; console.log((same ? 'kept           ' : 'MANGLED        ') + name.padEnd(34) + ' -> ' + out.slice(0, 64)) }
  console.log(`RESULT leaks=${leaks} mangled=${mangled} (2 known limits: a password written before its label, a bare UUID)`); process.exit(leaks || mangled ? 1 : 0)
})()
