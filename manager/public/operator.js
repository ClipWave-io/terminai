// TerminAI's own admin dashboard: every organisation, its members and their installs. The password is the server's
// setup token; it stays in this tab only (sessionStorage) and every request sends it.
const root = document.getElementById('op')
const el = (tag, attrs = {}, ...kids) => { const e = document.createElement(tag); for (const [k, v] of Object.entries(attrs)) k === 'class' ? e.className = v : e.setAttribute(k, v); for (const k of kids.flat()) if (k != null) e.append(k.nodeType ? k : String(k)); return e }
const ago = t => { if (!t) return 'never'; const m = Math.round((Date.now() - new Date(t)) / 60000); return m < 2 ? 'now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago` }
const day = t => t ? new Date(t).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' }) : '—'
async function get(path) {
  const r = await fetch(path, { headers: { 'x-setup-token': sessionStorage.getItem('opToken') || '' } })
  if (!r.ok) throw new Error(r.status === 404 ? 'Wrong password.' : r.status === 429 ? 'Too many tries: wait an hour.' : `Error ${r.status}`)
  return r.json()
}
function login(message = '') {
  const input = el('input', { type: 'password', placeholder: 'Operator password', autocomplete: 'current-password' })
  const form = el('form', { class: 'op-login' }, el('h1', {}, 'TerminAI operator'), el('p', {}, 'Every organisation and install. For TerminAI admins only.'), input, el('button', { type: 'submit' }, 'Open'), message ? el('p', { class: 'op-err' }, message) : null)
  form.onsubmit = e => { e.preventDefault(); sessionStorage.setItem('opToken', input.value); void show() }
  root.replaceChildren(form); input.focus()
}
async function show() {
  let data, feedback
  try { [data, feedback] = await Promise.all([get('/api/operator/orgs'), get('/api/operator/feedback')]) } catch (e) { sessionStorage.removeItem('opToken'); return login(e.message) }
  const t = data.totals
  const stats = el('div', { class: 'op-stats' }, ...[['Organisations', data.orgs.length], ['People', t.users], ['Mac installs', t.installs], ['Active today', t.active_day]].map(([k, v]) => el('div', {}, el('b', {}, v), el('span', {}, k))))
  const search = el('input', { type: 'search', placeholder: 'Search organisations or people' })
  const list = el('div', { class: 'op-orgs' })
  const draw = () => {
    const q = search.value.toLowerCase()
    list.replaceChildren(...data.orgs.filter(o => !q || o.name.toLowerCase().includes(q) || (o.people || []).some(p => `${p.name} ${p.email}`.toLowerCase().includes(q))).map(o => el('section', { class: 'op-org' },
      el('header', {}, el('h2', {}, o.name), el('small', {}, `${o.members} people · ${o.sessions} shared sessions · ${o.files} files · created ${day(o.created_at)} · last chat ${ago(o.last_chat)}`)),
      el('table', {}, el('tr', {}, ...['Name', 'Email', 'Role', 'Products', 'TerminAI', 'Last seen'].map(h => el('th', {}, h))),
        ...(o.people || []).map(p => el('tr', {}, el('td', {}, p.name), el('td', {}, p.email), el('td', {}, p.role), el('td', {}, p.products ? p.products.join(', ') : 'all'), el('td', {}, p.app || '—'), el('td', {}, ago(p.seen))))))))
  }
  search.oninput = draw; draw()
  const fb = el('section', { class: 'op-org' }, el('header', {}, el('h2', {}, 'Feedback'), el('small', {}, `${feedback.feedback.length} messages`)),
    el('table', {}, ...feedback.feedback.slice(0, 50).map(f => el('tr', {}, el('td', {}, day(f.created_at)), el('td', {}, f.app_version || ''), el('td', {}, f.email || ''), el('td', {}, f.message)))))
  const out = el('button', { class: 'op-out' }, 'Lock'); out.onclick = () => { sessionStorage.removeItem('opToken'); login() }
  root.replaceChildren(el('header', { class: 'op-top' }, el('h1', {}, 'TerminAI operator'), out), stats, search, list, fb)
}
sessionStorage.getItem('opToken') ? void show() : login()
