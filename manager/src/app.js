import { randomUUID, randomInt } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { transaction } from './db.js';
import { catalog } from './catalog.js';
import { ROLES, CLASSIFICATIONS, HttpError, requireThat, opaqueToken, digest, safeEqual, email, text, enumValue, uuid, hashPassword, verifyPassword, isAdmin, canReadConversation, canWriteConversation, catalogAllowed } from './security.js';

const unsafe = method => !['GET', 'HEAD', 'OPTIONS'].includes(method);
const publicUser = user => ({ id: user.id, email: user.email, name: user.name });
const publicCompany = row => ({ id: row.id, name: row.name, sessionVisibility: row.session_visibility || 'admins', products: row.products ?? null, role: row.role, classification: row.classification, defaultVisibility: row.default_visibility, allowCompanySharing: row.allow_company_sharing });
const publicConversation = row => ({ id: row.id, companyId: row.company_id, ownerId: row.owner_id, ownerName: row.owner_name, title: row.title, visibility: row.visibility, allowedRoles: row.allowed_roles, createdAt: row.created_at, updatedAt: row.updated_at,
  ...(row.source_key ? { tab: true, place: row.place, status: row.tab_status, live: !!row.seen_at && Date.now() - new Date(row.seen_at).getTime() < 120000 } : {}) });
const publicNote = row => ({ id: row.id, kind: row.kind || 'card', product: row.product || '', files: row.files || [], ownerId: row.owner_id, visibility: row.visibility, title: row.title, body: row.body, status: row.status, assigneeId: row.assignee_id, position: row.position, updatedBy: row.updated_by, updatedByName: row.updated_by_name, createdAt: row.created_at, updatedAt: row.updated_at });
const publicMessage = row => ({ id: row.id, conversationId: row.conversation_id, authorId: row.author_id, authorName: row.author_name, kind: row.kind, content: row.content, clientMessageId: row.client_message_id, createdAt: row.created_at });
function roles(value) {
  requireThat(Array.isArray(value) && value.length > 0 && value.length <= ROLES.length, 400, 'Choose at least one allowed role.');
  return [...new Set(value.map(v => enumValue(v, ROLES, 'role')))];
}
async function body(req) {
  requireThat((req.headers['content-type'] || '').split(';')[0] === 'application/json', 415, 'Use application/json.');
  let chunks = [], size = 0;
  for await (const chunk of req) { size += chunk.length; requireThat(size <= 131072, 413, 'Request too large.'); chunks.push(chunk); }
  try { const value = JSON.parse(Buffer.concat(chunks).toString()); requireThat(value && typeof value === 'object' && !Array.isArray(value), 400, 'Use a JSON object.'); return value; }
  catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(400, 'Invalid JSON.'); }
}
// A file attached to a note travels as the raw request body, never as JSON.
const MAX_FILE = 25 * 1024 * 1024, MAX_COMPANY_FILES = 1024 * 1024 * 1024;
async function rawBody(req) {
  requireThat((req.headers['content-type'] || '').split(';')[0] === 'application/octet-stream', 415, 'Use application/octet-stream.');
  let chunks = [], size = 0;
  for await (const chunk of req) { size += chunk.length; requireThat(size <= MAX_FILE, 413, 'Files can be up to 25 MB.'); chunks.push(chunk); }
  requireThat(size > 0, 400, 'The file is empty.');
  return Buffer.concat(chunks);
}
const publicFile = row => ({ id: row.id, name: row.name, mime: row.mime, size: row.size, createdAt: row.created_at });
/** A bot key's limits from a request, over the current ones. */
function botLimits(input, current) {
  const scope = input.scope === undefined ? current.scope : enumValue(input.scope, ['full', 'reply', 'read'], 'access');
  const approval = input.approval === undefined ? current.approval : input.approval === null ? null : enumValue(input.approval, ['every', 'risky', 'none'], 'approval');
  const conversations = input.conversations === undefined ? current.conversations : input.conversations === null ? null
    : (requireThat(Array.isArray(input.conversations) && input.conversations.length <= 200, 400, 'Invalid conversations.'), input.conversations.map(uuid));
  return { scope, approval, conversations };
}
async function limit(db, key, max, seconds) {
  const { rows: [row] } = await db.query(`INSERT INTO manager_rate_limits(key,count,resets_at) VALUES($1,1,now()+$2 * interval '1 second')
    ON CONFLICT(key) DO UPDATE SET count=CASE WHEN manager_rate_limits.resets_at<=now() THEN 1 ELSE manager_rate_limits.count+1 END,
    resets_at=CASE WHEN manager_rate_limits.resets_at<=now() THEN now()+$2*interval '1 second' ELSE manager_rate_limits.resets_at END RETURNING count`, [digest(key), seconds]);
  requireThat(row.count <= max, 429, 'Too many requests. Try again later.');
}
async function audit(db, companyId, userId, action, targetId) {
  await db.query('INSERT INTO manager_audit(id,company_id,actor_id,action,target_id) VALUES($1,$2,$3,$4,$5)', [randomUUID(), companyId, userId, action, targetId || null]);
}
async function defaultAssignments(db,companyId) {
  for(const role of ROLES)await db.query("INSERT INTO manager_catalog_assignments(company_id,catalog_id,subject_type,subject) VALUES($1,'chrome-devtools','role',$2)",[companyId,role]);
  for(const classification of ['analyst','marketing'])await db.query("INSERT INTO manager_catalog_assignments(company_id,catalog_id,subject_type,subject) VALUES($1,'google-ads','classification',$2)",[companyId,classification]);
}
async function newSession(db, userId, client) {
  const token = opaqueToken();
  const { rows: [session] } = await db.query(`INSERT INTO manager_sessions(id,token_hash,user_id,client,expires_at) VALUES($1,$2,$3,$4,now()+($5||' days')::interval) RETURNING id,expires_at`, [randomUUID(), digest(token), userId, client, client === 'desktop' ? '90' : '30']);
  return { token, sessionId: session.id, expiresAt: session.expires_at };
}
export function createApp(pool, config) {
  const origin = new URL(config.publicOrigin).origin;
  requireThat(origin === config.publicOrigin && (origin.startsWith('https:') || ['localhost','127.0.0.1','[::1]'].includes(new URL(origin).hostname)), 500, 'PUBLIC_ORIGIN must be an HTTPS origin (HTTP allowed only on localhost).');
  const secure = origin.startsWith('https:');
  const cookieName = secure ? '__Host-terminai_session' : 'terminai_session';
  const cookie = (value, age = 2592000) => `${cookieName}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${secure ? '; Secure' : ''}`;
  const entries = catalog(config);
  function json(res, status, value, headers = {}) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers }); res.end(JSON.stringify(value)); }
  /** A bot key (Authorization: Bearer tbot_…): the key's maker, marked as that bot, in that workspace only. */
  async function botAuth(req) {
    const key = req.headers.authorization?.match(/^Bearer tbot_([A-Za-z0-9_-]{43})$/)?.[1];
    if (!key) return null;
    const { rows: [user] } = await pool.query(`SELECT u.*,k.id AS bot_id,k.name AS bot_name,k.company_id AS bot_company,k.scope AS bot_scope,k.conversations AS bot_conversations FROM manager_bot_keys k JOIN manager_users u ON u.id=k.user_id
      WHERE k.token_hash=$1 AND k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at>now())`, [digest(key)]);
    requireThat(user, 401, 'Invalid or revoked bot key.');
    void pool.query('UPDATE manager_bot_keys SET last_used_at=now() WHERE id=$1 AND (last_used_at IS NULL OR last_used_at<now()-interval \'1 minute\')', [user.bot_id]).catch(() => {});
    return user;
  }
  async function auth(req) {
    const bot = await botAuth(req);
    if (bot) return bot;
    const bearer = req.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
    const cookieToken = (req.headers.cookie || '').split(';').map(p => p.trim()).find(p => p.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
    const token = bearer || cookieToken;
    requireThat(token && /^[A-Za-z0-9_-]{43}$/.test(token), 401, 'Sign in to continue.');
    if (!bearer && unsafe(req.method)) requireThat(req.headers.origin === origin, 403, 'Invalid request origin.');
    const { rows: [user] } = await pool.query(`SELECT u.*,s.id AS session_id FROM manager_sessions s JOIN manager_users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>now()`, [digest(token)]);
    requireThat(user, 401, 'Session expired. Sign in again.');
    // Which TerminAI version each signed-in Mac runs, and when it was last seen: shown under Members.
    const ver = String(req.headers['x-terminai-version'] || '').slice(0, 20);
    if (/^\d+\.\d+\.\d+$/.test(ver)) void pool.query("UPDATE manager_sessions SET app_version=$1,seen_at=now() WHERE id=$2 AND (app_version IS DISTINCT FROM $1 OR seen_at IS NULL OR seen_at<now()-interval '5 minutes')", [ver, user.session_id]).catch(() => {});
    // Used sessions stay: each use moves the end to 90 days (app) or 30 days (browser) from now, at most once a day.
    void pool.query(`UPDATE manager_sessions SET expires_at=now()+CASE WHEN client='desktop' THEN interval '90 days' ELSE interval '30 days' END WHERE id=$1 AND expires_at<now()+CASE WHEN client='desktop' THEN interval '89 days' ELSE interval '29 days' END`, [user.session_id]).catch(() => {});
    return user;
  }
  async function signedInResponse(req, res, db, user, input) {
    const client = input.client === 'desktop' ? 'desktop' : 'browser';
    const session = await newSession(db, user.id, client);
    return { status: 200, value: { user: publicUser(user), expiresAt: session.expiresAt, ...(client === 'desktop' ? { token: session.token } : {}) }, headers: client === 'browser' ? { 'Set-Cookie': cookie(session.token) } : {} };
  }
  let updatesCache = null;
  /** The newest TerminAI release from its latest-mac.yml: version, file names and the yml itself; stale on errors. */
  async function newestRelease() {
    if (updatesCache && Date.now() - updatesCache.at < 120000) return updatesCache;
    const r = await fetch('https://github.com/ClipWave-io/terminai/releases/latest/download/latest-mac.yml', { headers: { 'User-Agent': 'terminai-manager' }, signal: AbortSignal.timeout(10000) }).catch(() => null);
    const yml = r?.ok ? await r.text().catch(() => '') : '', version = /^version:\s*(\S+)/m.exec(yml)?.[1];
    if (!version) return updatesCache;
    updatesCache = { at: Date.now(), yml, version, files: [...yml.matchAll(/(?:url|path):\s*(\S+)/g)].map(m => m[1]) };
    return updatesCache;
  }
  return async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if (secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    // The site has one address (PUBLIC_ORIGIN, terminai.xyz): pages opened on any other host go there. The API answers
    // on every host, so the apps that call the Railway address directly keep working.
    const host = String(req.headers.host || '').toLowerCase();
    if ((req.method === 'GET' || req.method === 'HEAD') && host && host !== new URL(origin).host && !/^\/(api\/|health$|updates\/)/.test(req.url || '') && !/^(localhost|127\.0\.0\.1)(:|$)/.test(host)) {
      res.writeHead(301, { Location: origin + req.url }); return res.end();
    }
    try {
      const url = new URL(req.url, origin), path = url.pathname;
      if (req.method === 'GET' && path === '/health') { await pool.query('SELECT 1'); return json(res, 200, { ok: true }); }
      const staticFiles = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'], '/localflow': ['localflow.html', 'text/html'] };
      if (req.method === 'GET' && staticFiles[path]) {
        const [file, type] = staticFiles[path]; res.setHeader('Content-Type', `${type}; charset=utf-8`); return res.end(await readFile(new URL(`../public/${file}`, import.meta.url)));
      }
      // The newest signed Mac app, straight from GitHub's latest release: the website's Download button.
      // App updates, served here: /updates/<file of the newest TerminAI release>. No GitHub API (60 calls an hour per IP,
      // shared on Railway, so it ran out and answered 502): the public release files themselves. The newest version comes
      // from releases/latest/download/latest-mac.yml, cached two minutes, and the last good one is kept if GitHub hiccups.
      const upd = path.match(/^\/updates\/([A-Za-z0-9._-]{1,120})$/);
      if (req.method === 'GET' && upd) {
        const latest = await newestRelease();
        requireThat(latest, 502, 'Updates are not reachable right now.');
        if (upd[1] === 'latest-mac.yml') { res.writeHead(200, { 'Content-Type': 'text/yaml', 'Cache-Control': 'no-store' }); return res.end(latest.yml); }
        requireThat(latest.files.includes(upd[1]) || /\.blockmap$/.test(upd[1]) && latest.files.includes(upd[1].replace(/\.blockmap$/, '')), 404, 'Not found.');
        // A Range (the updater fetching only the changed blocks) goes through, and so does the 206 answer.
        const range = /^bytes=[\d,\s-]{1,200}$/.test(String(req.headers.range || '')) ? { Range: String(req.headers.range) } : {};
        const file = await fetch(`https://github.com/ClipWave-io/terminai/releases/download/v${latest.version}/${upd[1]}`, { headers: { 'User-Agent': 'terminai-manager', ...range }, signal: AbortSignal.timeout(600000) }).catch(() => null);
        requireThat(file?.ok && file.body, 502, 'Updates are not reachable right now.');
        const pass = ['content-length', 'content-range', 'content-type', 'accept-ranges'].flatMap(h => file.headers.get(h) ? [[h, file.headers.get(h)]] : []);
        res.writeHead(file.status, { 'Content-Type': 'application/octet-stream', ...Object.fromEntries(pass), 'Cache-Control': 'no-store' });
        const { Readable } = await import('node:stream');
        Readable.fromWeb(file.body).pipe(res);
        return;
      }
      // LocalFlow's DMG: the newest localflow-* release (a pre-release, so it never becomes TerminAI's latest).
      if (req.method === 'GET' && path === '/localflow/download') {
        const r = await fetch('https://api.github.com/repos/ClipWave-io/terminai/releases?per_page=30', { headers: { 'User-Agent': 'terminai-manager', Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(8000) }).catch(() => null);
        const rel = r?.ok ? (await r.json()).find(x => x.tag_name?.startsWith('localflow-')) : null, dmg = rel?.assets?.find(a => /\.dmg$/.test(a.name));
        res.writeHead(302, { Location: dmg?.browser_download_url ?? '/localflow', 'Cache-Control': 'no-store' });
        return res.end();
      }
      if (req.method === 'GET' && path === '/download/mac') {
        const latest = await newestRelease(), dmg = latest?.files.find(f => /\.dmg$/.test(f));
        res.writeHead(302, { Location: dmg ? `https://github.com/ClipWave-io/terminai/releases/download/v${latest.version}/${dmg}` : 'https://github.com/ClipWave-io/terminai/releases/latest', 'Cache-Control': 'no-store' });
        return res.end();
      }
      requireThat(path.startsWith('/api/'), 404, 'Not found.');
      // No CORS: browser UI is same-origin; desktop uses main-process HTTP with a bearer.
      if (req.headers.origin && unsafe(req.method)) requireThat(req.headers.origin === origin, 403, 'Invalid request origin.');
      const forwarded = String(req.headers['x-forwarded-for'] || '').split(',').map(s => s.trim());
      const ip = config.trustProxyHops > 0 ? forwarded.at(-config.trustProxyHops) || req.socket.remoteAddress : req.socket.remoteAddress;
      await limit(pool, `api:${ip}`, 300, 60);
      // Continue with Google: an account by its verified Google email (made the first time), signed in in this browser.
      if (req.method === 'GET' && path === '/api/auth/google' && config.google) {
        const state = opaqueToken();
        const q = new URLSearchParams({ client_id: config.google.id, redirect_uri: `${origin}/api/auth/google/callback`, response_type: 'code', scope: 'openid email profile', state, prompt: 'select_account' });
        res.writeHead(302, { Location: `https://accounts.google.com/o/oauth2/v2/auth?${q}`, 'Set-Cookie': `terminai_gstate=${state}; Path=/api/auth/google; HttpOnly; SameSite=Lax; Max-Age=600${secure ? '; Secure' : ''}` });
        return res.end();
      }
      if (req.method === 'GET' && path === '/api/auth/google/callback' && config.google) {
        const state = (req.headers.cookie || '').split(';').map(p => p.trim()).find(p => p.startsWith('terminai_gstate='))?.slice(16);
        requireThat(state && safeEqual(state, url.searchParams.get('state') || ''), 400, 'Sign-in expired. Try again.');
        const tokens = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: AbortSignal.timeout(10000),
          body: new URLSearchParams({ code: url.searchParams.get('code') || '', client_id: config.google.id, client_secret: config.google.secret, redirect_uri: `${origin}/api/auth/google/callback`, grant_type: 'authorization_code' }) }).then(r => r.json());
        requireThat(tokens.access_token, 401, 'Google did not sign you in.');
        const g = await fetch('https://openidconnect.googleapis.com/v1/userinfo', { headers: { Authorization: `Bearer ${tokens.access_token}` }, signal: AbortSignal.timeout(10000) }).then(r => r.json());
        requireThat(g.email && g.email_verified, 401, 'Your Google email is not verified.');
        const accountEmail = email(g.email);
        const response = await transaction(pool, async db => {
          await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [accountEmail]);
          let { rows: [user] } = await db.query('SELECT * FROM manager_users WHERE email=$1', [accountEmail]);
          if (!user) {
            requireThat(config.signupOpen !== false, 403, 'Sign-up is closed on this server.');
            user = { id: randomUUID(), email: accountEmail, name: text(g.name || accountEmail.split('@')[0], 'Name') };
            const companyId = randomUUID();
            await db.query("INSERT INTO manager_users(id,email,name,password_hash) VALUES($1,$2,$3,'')", [user.id, user.email, user.name]);
            await db.query('INSERT INTO manager_companies(id,name) VALUES($1,$2)', [companyId, `${user.name.split(' ')[0]}’s workspace`.slice(0, 120)]);
            await db.query("INSERT INTO manager_memberships(company_id,user_id,role) VALUES($1,$2,'owner')", [companyId, user.id]);
            await defaultAssignments(db, companyId);
          }
          return signedInResponse(req, res, db, user, { client: 'browser' });
        });
        res.writeHead(302, { Location: '/', 'Set-Cookie': [response.headers['Set-Cookie'], 'terminai_gstate=; Path=/api/auth/google; Max-Age=0'] });
        return res.end();
      }
      // Operator view (us, with the server's setup secret): every account, its workspaces and the newest app it signed in with.
      if (req.method === 'POST' && path === '/api/feedback') {
        const input = await body(req);
        await limit(pool, `feedback:${req.socket.remoteAddress}`, 20, 3600);
        const message = text(input.message, 'Message', 8000), email = typeof input.email === 'string' && /^[^\s@]{1,100}@[^\s@]{1,200}$/.test(input.email.trim()) ? input.email.trim() : null;
        await pool.query('INSERT INTO manager_feedback(id,email,message,app_version) VALUES($1,$2,$3,$4)', [randomUUID(), email, message, String(req.headers['x-terminai-version'] || input.version || '').slice(0, 40) || null]);
        return json(res, 200, { ok: true });
      }
      if (req.method === 'GET' && path === '/api/operator/feedback') {
        requireThat(config.setupToken?.length >= 32 && safeEqual(String(req.headers['x-setup-token'] || ''), config.setupToken), 404, 'Not found.');
        return json(res, 200, { feedback: (await pool.query('SELECT email,message,app_version,created_at FROM manager_feedback ORDER BY created_at DESC LIMIT 500')).rows });
      }
      if (req.method === 'GET' && path === '/api/operator/users') {
        requireThat(config.setupToken?.length >= 32 && safeEqual(String(req.headers['x-setup-token'] || ''), config.setupToken), 404, 'Not found.');
        const { rows } = await pool.query(`SELECT u.name,u.email,u.created_at,
            (SELECT string_agg(c.name||' ('||m.role||')',', ') FROM manager_memberships m JOIN manager_companies c ON c.id=m.company_id WHERE m.user_id=u.id) AS workspaces,
            (SELECT string_agg(DISTINCT s.client,', ') FROM manager_sessions s WHERE s.user_id=u.id) AS clients,
            (SELECT s.app_version FROM manager_sessions s WHERE s.user_id=u.id AND s.app_version IS NOT NULL ORDER BY coalesce(s.seen_at,s.created_at) DESC LIMIT 1) AS app_version,
            (SELECT max(coalesce(s.seen_at,s.created_at)) FROM manager_sessions s WHERE s.user_id=u.id) AS last_seen
          FROM manager_users u ORDER BY u.created_at`);
        return json(res, 200, { users: rows });
      }
      if (req.method === 'GET' && path === '/api/setup') {
        const { rows: [row] } = await pool.query('SELECT EXISTS(SELECT 1 FROM manager_users) AS initialized');
        return json(res, 200, { setupRequired: !row.initialized, setupEnabled: Boolean(config.setupToken), signupOpen: config.signupOpen !== false, google: Boolean(config.google) });
      }
      if (req.method === 'POST' && ['/api/setup','/api/auth/signup','/api/auth/login','/api/auth/accept-invite'].includes(path)) {
        await limit(pool, `auth:${ip}`, 20, 900);
        const input = await body(req);
        if (path === '/api/auth/login') {
          const accountEmail = email(input.email);
          await limit(pool, `login:${accountEmail}`, 10, 900);
          const { rows: [user] } = await pool.query('SELECT * FROM manager_users WHERE email=$1', [accountEmail]);
          const valid = await verifyPassword(input.password, user?.password_hash);
          requireThat(user && valid, 401, 'Email or password is incorrect.');
          const response = await transaction(pool,async db=>{
            const {rows:[current]}=await db.query('SELECT password_hash FROM manager_users WHERE id=$1 FOR UPDATE',[user.id]);
            requireThat(current.password_hash===user.password_hash,401,'Password changed. Sign in again.');
            return signedInResponse(req,res,db,user,input);
          });
          return json(res,response.status,response.value,response.headers);
        }
        if (path === '/api/auth/signup') {
          // Anyone can create an account: it owns a workspace of its own, used alone or shared later. Joining someone else's is by invitation only.
          requireThat(config.signupOpen !== false, 403, 'Sign-up is closed on this server. Ask for an invitation.');
          const accountEmail = email(input.email), name = text(input.name,'Name'), companyName = input.companyName ? text(input.companyName,'Workspace name') : `${name.split(' ')[0]}’s workspace`.slice(0,120);
          await limit(pool, `signup:${ip}`, 5, 3600);
          const passwordHash = await hashPassword(input.password);
          const response = await transaction(pool, async db => {
            await db.query('SELECT pg_advisory_xact_lock(hashtext($1))',[accountEmail]);
            const { rowCount } = await db.query('SELECT id FROM manager_users WHERE email=$1',[accountEmail]);
            requireThat(!rowCount, 409, 'An account with this email already exists. Sign in instead.');
            const user = { id: randomUUID(), email: accountEmail, name }, companyId = randomUUID();
            await db.query('INSERT INTO manager_users(id,email,name,password_hash) VALUES($1,$2,$3,$4)', [user.id,user.email,user.name,passwordHash]);
            await db.query('INSERT INTO manager_companies(id,name) VALUES($1,$2)',[companyId,companyName]);
            await db.query("INSERT INTO manager_memberships(company_id,user_id,role) VALUES($1,$2,'owner')",[companyId,user.id]);
            await defaultAssignments(db,companyId);
            await audit(db,companyId,user.id,'company.created',companyId);
            return signedInResponse(req,res,db,user,input);
          });
          return json(res,response.status,response.value,response.headers);
        }
        if (path === '/api/setup') {
          requireThat(config.setupToken?.length >= 32 && safeEqual(input.setupToken, config.setupToken), 403, 'Invalid setup token.');
          const accountEmail = email(input.email), name = text(input.name,'Name'), companyName = text(input.companyName,'Company name');
          const passwordHash = await hashPassword(input.password);
          const response = await transaction(pool, async db => {
            await db.query('SELECT pg_advisory_xact_lock(73920812)');
            const { rowCount } = await db.query('SELECT id FROM manager_users LIMIT 1');
            requireThat(!rowCount, 409, 'Setup is already complete.');
            const user = { id: randomUUID(), email: accountEmail, name }, companyId = randomUUID();
            await db.query('INSERT INTO manager_users(id,email,name,password_hash) VALUES($1,$2,$3,$4)', [user.id, user.email,user.name,passwordHash]);
            await db.query('INSERT INTO manager_companies(id,name) VALUES($1,$2)',[companyId,companyName]);
            await db.query("INSERT INTO manager_memberships(company_id,user_id,role) VALUES($1,$2,'owner')",[companyId,user.id]);
            await defaultAssignments(db,companyId);
            await audit(db,companyId,user.id,'company.created',companyId);
            return signedInResponse(req,res,db,user,input);
          });
          return json(res,response.status,response.value,response.headers);
        }
        requireThat(typeof input.token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(input.token), 400, 'Invalid invitation.');
        const signedIn = await auth(req).catch(() => null);
        // Hash work occurs before locks; accepting existing accounts must verify their current password.
        const response = await transaction(pool, async db => {
          const { rows: [invite] } = await db.query('SELECT * FROM manager_invites WHERE token_hash=$1', [digest(input.token)]);
          if (!invite) {
            // A link: whoever opens it joins with their own name and email, until it expires.
            const { rows: [link] } = await db.query('SELECT * FROM manager_invite_links WHERE token_hash=$1 FOR SHARE', [digest(input.token)]);
            requireThat(link && !link.revoked_at && new Date(link.expires_at) > new Date(), 410, 'This invitation link has expired. Ask for a new one.');
            let user = signedIn;
            if (!user) {
              const accountEmail = email(input.email);
              await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [accountEmail]);
              const { rows: [existing] } = await db.query('SELECT * FROM manager_users WHERE email=$1 FOR UPDATE', [accountEmail]);
              if (existing) {
                // Never a way into someone's account: an existing one proves itself with its password (or by being signed in).
                requireThat(existing.password_hash && await verifyPassword(input.password, existing.password_hash), 401, 'That email already has an account: sign in first, then open the link again.');
                user = existing;
              } else {
                user = { id: randomUUID(), email: accountEmail, name: text(input.name, 'Name') };
                await db.query('INSERT INTO manager_users(id,email,name,password_hash) VALUES($1,$2,$3,$4)', [user.id, user.email, user.name, input.password ? await hashPassword(input.password) : '']);
              }
            }
            await db.query("INSERT INTO manager_memberships(company_id,user_id,role) VALUES($1,$2,$3) ON CONFLICT DO NOTHING", [link.company_id, user.id, link.role]);
            await audit(db, link.company_id, user.id, 'invite_link.used', link.id);
            return signedInResponse(req, res, db, user, input);
          }
          // Same lock order as company mutations, preventing accept/revoke deadlocks.
          await db.query('SELECT id FROM manager_companies WHERE id=$1 FOR UPDATE',[invite.company_id]);
          const { rows: [locked] } = await db.query('SELECT * FROM manager_invites WHERE id=$1 FOR UPDATE',[invite.id]);
          requireThat(!locked.accepted_at && !locked.revoked_at && new Date(locked.expires_at)>new Date(), 410, 'Invitation expired or already used.');
          await db.query('SELECT pg_advisory_xact_lock(hashtext($1))',[locked.email]);
          let { rows: [user] } = await db.query('SELECT * FROM manager_users WHERE email=$1 FOR UPDATE',[locked.email]);
          if (user) requireThat(signedIn?.id===user.id || await verifyPassword(input.password,user.password_hash),401,'Enter the existing account password.');
          else {
            user = { id: randomUUID(),email:locked.email,name:text(input.name,'Name') };
            // A password is optional: the invitation link signs the person in, and other devices sign in with a code allowed from here.
            const passwordHash = input.password ? await hashPassword(input.password) : '';
            await db.query('INSERT INTO manager_users(id,email,name,password_hash) VALUES($1,$2,$3,$4)',[user.id,user.email,user.name,passwordHash]);
          }
          await db.query('INSERT INTO manager_memberships(company_id,user_id,role,classification) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[locked.company_id,user.id,locked.role,locked.classification]);
          await db.query('UPDATE manager_invites SET accepted_at=now() WHERE id=$1',[locked.id]);
          await audit(db,locked.company_id,user.id,'invite.accepted',locked.id);
          return signedInResponse(req,res,db,user,input);
        });
        return json(res,response.status,response.value,response.headers);
      }
      // Sign in with the browser: the app shows a code and opens the site; a signed-in person there allows it; the app
      // collects a desktop session with its poll token. Nothing secret is ever typed into the app.
      const deviceCode = value => { requireThat(typeof value === 'string' && /^[A-Z2-9]{4}-?[A-Z2-9]{4}$/i.test(value.trim()), 400, 'Enter the code shown in the app.'); return value.trim().toUpperCase().replace('-', ''); };
      if (req.method === 'POST' && path === '/api/auth/device/start') {
        await limit(pool, `device:${ip}`, 20, 900);
        const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789', code = Array.from({ length: 8 }, () => alphabet[randomInt(alphabet.length)]).join(''), pollToken = opaqueToken();
        await pool.query("INSERT INTO manager_device_logins(id,code_hash,poll_hash,expires_at) VALUES($1,$2,$3,now()+interval '10 minutes')", [randomUUID(), digest(code), digest(pollToken)]);
        const shown = `${code.slice(0, 4)}-${code.slice(4)}`;
        return json(res, 200, { code: shown, pollToken, expiresIn: 600, verifyUrl: `${origin}/#device=${shown}` });
      }
      if (req.method === 'POST' && path === '/api/auth/device/poll') {
        const input = await body(req);
        requireThat(typeof input.pollToken === 'string' && /^[A-Za-z0-9_-]{43}$/.test(input.pollToken), 400, 'Invalid request.');
        const response = await transaction(pool, async db => {
          const { rows: [login] } = await db.query('SELECT * FROM manager_device_logins WHERE poll_hash=$1 FOR UPDATE', [digest(input.pollToken)]);
          requireThat(login && !login.consumed_at && new Date(login.expires_at) > new Date(), 410, 'This sign-in expired. Start again.');
          if (!login.user_id) return { status: 200, value: { pending: true } };
          await db.query('UPDATE manager_device_logins SET consumed_at=now() WHERE id=$1', [login.id]);
          const { rows: [user] } = await db.query('SELECT * FROM manager_users WHERE id=$1', [login.user_id]);
          return signedInResponse(req, res, db, user, { client: input.client === 'browser' ? 'browser' : 'desktop' });
        });
        return json(res, response.status, response.value, response.headers);
      }
      const user = await auth(req);
      // "Open TerminAI" on the website: a one-time code (10 minutes) the Mac app trades for its own session, through terminai://signin.
      if (req.method === 'POST' && path === '/api/auth/handoff') {
        await limit(pool, `handoff:${user.id}`, 20, 900);
        const pollToken = opaqueToken(), code = Array.from({ length: 8 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[randomInt(32)]).join('');
        await pool.query("INSERT INTO manager_device_logins(id,code_hash,poll_hash,user_id,expires_at) VALUES($1,$2,$3,$4,now()+interval '10 minutes')", [randomUUID(), digest(code), digest(pollToken), user.id]);
        return json(res, 200, { url: `terminai://signin?code=${pollToken}&server=${encodeURIComponent(config.apiOrigin || origin)}` });
      }
      if (req.method === 'POST' && path === '/api/auth/device/approve') {
        const input = await body(req), code = deviceCode(input.code);
        await limit(pool, `approve:${user.id}`, 20, 900);
        const { rowCount } = await pool.query('UPDATE manager_device_logins SET user_id=$1 WHERE code_hash=$2 AND user_id IS NULL AND consumed_at IS NULL AND expires_at>now()', [user.id, digest(code)]);
        requireThat(rowCount, 404, 'That code is not valid any more. Start again in the app.');
        return json(res, 200, { ok: true });
      }
      if (req.method === 'GET' && path === '/api/me') {
        const { rows } = await pool.query('SELECT c.*,m.role,m.classification FROM manager_companies c JOIN manager_memberships m ON m.company_id=c.id WHERE m.user_id=$1 ORDER BY c.name',[user.id]);
        return json(res,200,{ user:publicUser(user), companies:rows.map(publicCompany) });
      }
      if (req.method === 'PATCH' && path === '/api/me') {
        const input = await body(req), name = text(input.name,'Name');
        await pool.query('UPDATE manager_users SET name=$1 WHERE id=$2',[name,user.id]);
        return json(res,200,{ user:publicUser({...user,name}) });
      }
      if (req.method === 'POST' && path === '/api/auth/logout') {
        await pool.query('UPDATE manager_sessions SET revoked_at=now() WHERE id=$1',[user.session_id]);
        return json(res,200,{ok:true},{'Set-Cookie':cookie('',0)});
      }
      if (req.method === 'GET' && path === '/api/auth/sessions') {
        const { rows } = await pool.query('SELECT id,client,created_at,expires_at FROM manager_sessions WHERE user_id=$1 AND revoked_at IS NULL AND expires_at>now() ORDER BY created_at DESC',[user.id]);
        return json(res,200,{sessions:rows.map(s=>({...s,current:s.id===user.session_id}))});
      }
      if (req.method === 'DELETE' && /^\/api\/auth\/sessions\/[^/]+$/.test(path)) {
        await pool.query('UPDATE manager_sessions SET revoked_at=now() WHERE id=$1 AND user_id=$2',[uuid(path.split('/').at(-1)),user.id]);
        return json(res,200,{ok:true});
      }
      if (req.method === 'POST' && path === '/api/auth/password') {
        const input = await body(req);
        await limit(pool,`password:${user.id}`,5,900);
        requireThat(!user.bot_id,403,'Not for bots.');
        const passwordHash = await hashPassword(input.password);
        // From the signed-in TerminAI app (its own device), a password is set without the old one, and its devices stay signed in.
        const {rows:[session]}=await pool.query('SELECT client FROM manager_sessions WHERE id=$1',[user.session_id]);
        const fromApp=session?.client==='desktop'&&!input.currentPassword;
        await transaction(pool,async db=>{
          const {rows:[current]}=await db.query('SELECT password_hash FROM manager_users WHERE id=$1 FOR UPDATE',[user.id]);
          requireThat(fromApp || current.password_hash==='' || await verifyPassword(input.currentPassword,current.password_hash),401,'Current password is incorrect.');
          await db.query('UPDATE manager_users SET password_hash=$1 WHERE id=$2',[passwordHash,user.id]);
          if(fromApp)await db.query("UPDATE manager_sessions SET revoked_at=now() WHERE user_id=$1 AND client='browser'",[user.id]);
          else await db.query('UPDATE manager_sessions SET revoked_at=now() WHERE user_id=$1',[user.id]);
        });
        return json(res,200,{ok:true,signInRequired:!fromApp},fromApp?{}:{'Set-Cookie':cookie('',0)});
      }
      if (req.method === 'POST' && path === '/api/companies') {
        const input = await body(req), name = text(input.name,'Company name'), companyId=randomUUID();
        await limit(pool,`create-company:${user.id}`,5,86400);
        await transaction(pool,async db=>{
          await db.query('INSERT INTO manager_companies(id,name) VALUES($1,$2)',[companyId,name]);
          await db.query("INSERT INTO manager_memberships(company_id,user_id,role) VALUES($1,$2,'owner')",[companyId,user.id]);
          await defaultAssignments(db,companyId);
          await audit(db,companyId,user.id,'company.created',companyId);
        });
        return json(res,201,{id:companyId,name});
      }
      // Team files and chat: a raw-body upload and long polls, so outside the JSON company route below.
      const teamRoute = path.match(/^\/api\/companies\/([0-9a-f-]{36})\/(files|chat)(?:\/([^/]+))?$/);
      if (teamRoute && !user.bot_id) {
        const companyId = teamRoute[1], kind = teamRoute[2], sub = teamRoute[3] || '';
        const { rows: [member] } = await pool.query('SELECT * FROM manager_memberships WHERE company_id=$1 AND user_id=$2', [companyId, user.id]);
        requireThat(member, 404, 'Company not found.');
        const adminish = isAdmin(member);
        const canSee = f => adminish || f.created_by === user.id || f.access === 'all' || (f.access === 'products' && (!member.products || (f.products || []).some(p => member.products.includes(p))));
        const meta = f => ({ id: f.id, name: f.name, mime: f.mime, size: f.size, access: f.access, products: f.products, by: f.created_by, byName: f.by_name, createdAt: f.created_at, fromChat: f.from_chat });
        const seen = (typing = false) => pool.query(`INSERT INTO manager_presence(company_id,user_id,seen_at,typing_until) VALUES($1,$2,now(),${typing ? "now()+interval '6 seconds'" : 'NULL'})
          ON CONFLICT (company_id,user_id) DO UPDATE SET seen_at=now()${typing ? ",typing_until=now()+interval '6 seconds'" : ''}`, [companyId, user.id]);
        if (kind === 'files' && !sub && req.method === 'GET') {
          const { rows } = await pool.query('SELECT f.id,f.name,f.mime,f.size,f.access,f.products,f.created_by,f.created_at,f.from_chat,u.name AS by_name FROM manager_team_files f LEFT JOIN manager_users u ON u.id=f.created_by WHERE f.company_id=$1 ORDER BY f.created_at DESC LIMIT 2000', [companyId]);
          return json(res, 200, { files: rows.filter(canSee).map(meta) });
        }
        if (kind === 'files' && !sub && req.method === 'POST') {
          requireThat(member.role !== 'viewer', 403, 'Viewers cannot add files.');
          const data = await rawBody(req);
          const { rows: [total] } = await pool.query('SELECT coalesce(sum(size),0)::bigint AS s FROM manager_team_files WHERE company_id=$1', [companyId]);
          requireThat(Number(total.s) + data.length <= 5 * MAX_COMPANY_FILES, 413, 'This workspace is out of file space.');
          const name = text(url.searchParams.get('name'), 'File name', 200).replace(/[\\/\u0000-\u001f]/g, '_');
          const mime = /^[a-z]+\/[a-z0-9.+-]{1,100}$/i.test(url.searchParams.get('type') || '') ? url.searchParams.get('type').toLowerCase() : 'application/octet-stream';
          const access = enumValue(url.searchParams.get('access') || 'all', ['all', 'admins', 'products'], 'access');
          const products = access === 'products' ? (url.searchParams.get('products') || '').split(',').map(x => x.trim()).filter(Boolean).slice(0, 20) : null;
          const { rows: [row] } = await pool.query('INSERT INTO manager_team_files(id,company_id,name,mime,size,data,access,products,created_by,from_chat) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id,name,mime,size,access,products,created_by,created_at,from_chat',
            [randomUUID(), companyId, name, mime, data.length, data, access, products, user.id, url.searchParams.get('chat') === '1']);
          return json(res, 200, { file: meta({ ...row, by_name: user.name }) });
        }
        if (kind === 'files' && sub) {
          const id = uuid(sub);
          const { rows: [f] } = await pool.query(`SELECT id,name,mime,size,access,products,created_by,created_at,from_chat${req.method === 'GET' ? ',data' : ''} FROM manager_team_files WHERE id=$1 AND company_id=$2`, [id, companyId]);
          requireThat(f && canSee(f), 404, 'File not found.');
          if (req.method === 'GET') { res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': f.data.length, 'Cache-Control': 'private, max-age=31536000, immutable', 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(f.name)}` }); return res.end(f.data); }
          requireThat(adminish || f.created_by === user.id, 403, 'Only its uploader or an admin can change it.');
          if (req.method === 'DELETE') { await pool.query('DELETE FROM manager_team_files WHERE id=$1', [id]); return json(res, 200, { ok: true }); }
          if (req.method === 'PATCH') {
            const input = await body(req);
            const access = input.access === undefined ? f.access : enumValue(input.access, ['all', 'admins', 'products'], 'access');
            const products = access !== 'products' ? null : input.products === undefined ? f.products : (requireThat(Array.isArray(input.products), 400, 'Invalid products.'), input.products.map(String).map(x => x.trim()).filter(Boolean).slice(0, 20));
            const name = input.name === undefined ? f.name : text(input.name, 'File name', 200).replace(/[\\/\u0000-\u001f]/g, '_');
            await pool.query('UPDATE manager_team_files SET access=$1,products=$2,name=$3 WHERE id=$4', [access, products, name, id]);
            return json(res, 200, { file: meta({ ...f, access, products, name }) });
          }
        }
        if (kind === 'chat' && !sub && req.method === 'GET') {
          // Long poll: answers at once when there is something newer than `after`, else waits up to `wait` seconds.
          const after = url.searchParams.get('after'), wait = Math.min(25, Math.max(0, Number(url.searchParams.get('wait')) || 0));
          requireThat(!after || Number.isFinite(Date.parse(after)), 400, 'Invalid cursor.');
          await seen();
          const fetchNew = () => pool.query(`SELECT c.id,c.body,c.created_at,c.from_user,u.name AS from_name,f.id AS fid,f.name AS fname,f.mime,f.size,f.access,f.products,f.created_by
              FROM manager_chat c JOIN manager_users u ON u.id=c.from_user LEFT JOIN manager_team_files f ON f.id=c.file_id
              WHERE c.company_id=$1 AND ($2::timestamptz IS NULL OR c.created_at>$2) ORDER BY c.created_at DESC LIMIT 200`, [companyId, after || null]).then(r => r.rows.reverse());
          let rows = await fetchNew(), closed = false; req.on('close', () => { closed = true });
          const typingKey = async () => (await pool.query("SELECT string_agg(user_id::text,',') AS t FROM manager_presence WHERE company_id=$1 AND user_id<>$2 AND typing_until>now()", [companyId, user.id])).rows[0].t || '';
          const typing0 = url.searchParams.get('typing') ?? '';
          const until = Date.now() + wait * 1000;
          while (!rows.length && !closed && Date.now() < until && (await typingKey()) === typing0) { await new Promise(r => setTimeout(r, 600)); rows = await fetchNew(); }
          if (closed) return;
          const { rows: people } = await pool.query(`SELECT u.id,u.name,p.seen_at,p.read_at,(p.typing_until>now()) AS typing FROM manager_memberships m JOIN manager_users u ON u.id=m.user_id
            LEFT JOIN manager_presence p ON p.company_id=m.company_id AND p.user_id=m.user_id WHERE m.company_id=$1`, [companyId]);
          return json(res, 200, { messages: rows.map(r => ({ id: r.id, body: r.body, at: r.created_at, from: r.from_user, fromName: r.from_name,
              file: r.fid ? (canSee({ access: r.access, products: r.products, created_by: r.created_by }) ? { id: r.fid, name: r.fname, mime: r.mime, size: r.size } : { hidden: true }) : null })),
            people: people.map(p => ({ id: p.id, name: p.name, seenAt: p.seen_at, readAt: p.read_at, typing: !!p.typing && p.id !== user.id, online: !!p.seen_at && Date.now() - new Date(p.seen_at).getTime() < 60000 })), me: user.id });
        }
        if (kind === 'chat' && req.method === 'POST') {
          const input = await body(req);
          if (sub === 'typing') { await seen(true); return json(res, 200, { ok: true }); }
          if (sub === 'read') { await seen(); await pool.query('UPDATE manager_presence SET read_at=now(),seen_at=now() WHERE company_id=$1 AND user_id=$2', [companyId, user.id]); return json(res, 200, { ok: true }); }
          requireThat(!sub && member.role !== 'viewer', 403, 'Viewers cannot write in the chat.');
          const bodyText = typeof input.body === 'string' ? input.body.slice(0, 8000) : '', fileId = input.fileId ? uuid(input.fileId) : null;
          requireThat(bodyText.trim() || fileId, 400, 'Write something.');
          if (fileId) { const { rowCount } = await pool.query('SELECT 1 FROM manager_team_files WHERE id=$1 AND company_id=$2', [fileId, companyId]); requireThat(rowCount, 404, 'File not found.'); }
          await limit(pool, `chat:${user.id}`, 600, 3600);
          const { rows: [row] } = await pool.query('INSERT INTO manager_chat(id,company_id,from_user,body,file_id) VALUES($1,$2,$3,$4,$5) RETURNING id,created_at', [randomUUID(), companyId, user.id, bodyText, fileId]);
          await seen(); await pool.query("UPDATE manager_presence SET typing_until=NULL,seen_at=now(),read_at=now() WHERE company_id=$1 AND user_id=$2", [companyId, user.id]);
          return json(res, 200, { id: row.id, at: row.created_at });
        }
        throw new HttpError(404, 'Not found.');
      }
      const fileRoute = path.match(/^\/api\/companies\/([^/]+)\/notes\/([^/]+)\/files(?:\/([^/]+))?$/);
      if (fileRoute) {
        const companyId=uuid(fileRoute[1]), noteId=uuid(fileRoute[2]), fileId=fileRoute[3]?uuid(fileRoute[3]):null;
        requireThat(fileId ? ['GET','DELETE'].includes(req.method) : req.method==='POST', 405, 'Unsupported file action.');
        const data = req.method==='POST' ? await rawBody(req) : null;
        const result = await transaction(pool, async db => {
          const { rows:[member] } = await db.query('SELECT * FROM manager_memberships WHERE company_id=$1 AND user_id=$2',[companyId,user.id]);
          requireThat(member,404,'Company not found.');
          const { rows:[note] } = await db.query(`SELECT * FROM manager_notes WHERE id=$1 AND company_id=$2 FOR ${req.method==='GET'?'SHARE':'UPDATE'}`,[noteId,companyId]);
          requireThat(note&&(note.visibility==='company'||note.owner_id===user.id),404,'Note not found.');
          if (req.method==='GET') {
            const { rows:[file] } = await db.query('SELECT name,data FROM manager_note_files WHERE id=$1 AND note_id=$2',[fileId,noteId]);
            requireThat(file,404,'File not found.'); return file;
          }
          requireThat(note.visibility==='private'||member.role!=='viewer',403,'Viewers cannot change shared notes.');
          if (req.method==='DELETE') {
            const { rowCount } = await db.query('DELETE FROM manager_note_files WHERE id=$1 AND note_id=$2',[fileId,noteId]);
            requireThat(rowCount,404,'File not found.');
          } else {
            const { rows:[used] } = await db.query('SELECT count(*)::int AS n FROM manager_note_files WHERE note_id=$1',[noteId]);
            requireThat(used.n < 50, 400, 'A note can hold up to 50 files.');
            const { rows:[total] } = await db.query('SELECT coalesce(sum(size),0)::bigint AS s FROM manager_note_files WHERE company_id=$1',[companyId]);
            requireThat(Number(total.s) + data.length <= MAX_COMPANY_FILES, 413, 'This workspace is out of file space (1 GB).');
            const name = text(url.searchParams.get('name'),'File name',200).replace(/[\\/\u0000-\u001f]/g,'_');
            const mime = /^[a-z]+\/[a-z0-9.+-]{1,100}$/i.test(url.searchParams.get('type')||'') ? url.searchParams.get('type').toLowerCase() : 'application/octet-stream';
            const { rows:[row] } = await db.query('INSERT INTO manager_note_files(id,note_id,company_id,name,mime,size,data,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id,name,mime,size,created_at',
              [randomUUID(),noteId,companyId,name,mime,data.length,data,user.id]);
            await db.query('UPDATE manager_notes SET updated_by=$1,updated_at=now() WHERE id=$2',[user.id,noteId]);
            return { file: publicFile(row) };
          }
          await db.query('UPDATE manager_notes SET updated_by=$1,updated_at=now() WHERE id=$2',[user.id,noteId]);
          return { ok: true };
        });
        // Always a download, never rendered by the browser: an uploaded HTML or SVG file cannot run on this origin.
        if (req.method==='GET') { res.writeHead(200,{ 'Content-Type':'application/octet-stream', 'Content-Length':result.data.length, 'Content-Disposition':`attachment; filename*=UTF-8''${encodeURIComponent(result.name)}` }); return res.end(result.data); }
        return json(res,200,result);
      }
      const match = path.match(/^\/api\/companies\/([^/]+)(\/.*)?$/);
      if (match) {
        const u0 = await botAuth(req).catch(() => null);
        if (u0) requireThat(match[1] === u0.bot_company && /^\/(conversations|conversations\/[0-9a-f-]{36}\/messages|agent|agent\/[0-9a-f-]{36}\/replies)$/.test(match[2] || '') && (req.method === 'GET' || (req.method === 'POST' && match[2] === '/agent')), 403, 'A bot key can list, read and message shared sessions only.');
      }
      requireThat(match,404,'Not found.');
      const companyId=uuid(match[1]), tail=match[2]||'', input=unsafe(req.method) && req.method!=='DELETE' ? await body(req) : {};
      // The inbox as a long poll (?wait=25): answered the moment a message for this person's sessions arrives, at most 25 s later empty.
      if(tail==='/agent/inbox'&&req.method==='GET'&&url.searchParams.get('wait')){
        const until=Date.now()+Math.min(25,Math.max(1,Number(url.searchParams.get('wait'))||25))*1000;
        let closed=false;req.on('close',()=>{closed=true});
        while(!closed&&Date.now()<until){
          const {rowCount}=await pool.query("SELECT 1 FROM manager_agent_messages m JOIN manager_conversations t ON t.id=m.to_conversation WHERE m.company_id=$1 AND t.owner_id=$2 AND m.delivered_at IS NULL AND m.created_at>now()-interval '1 day' LIMIT 1",[companyId,user.id]);
          if(rowCount)break;
          await new Promise(r=>setTimeout(r,700));
        }
        if(closed)return;
      }
      const result=await transaction(pool,async db=>{
        const { rows:[company] }=await db.query(`SELECT * FROM manager_companies WHERE id=$1 FOR ${unsafe(req.method)?'UPDATE':'SHARE'}`,[companyId]);
        const { rows:[member] }=await db.query('SELECT * FROM manager_memberships WHERE company_id=$1 AND user_id=$2',[companyId,user.id]);
        requireThat(company&&member,404,'Company not found.');
        const admin=()=>requireThat(isAdmin(member),403,'Administrator access required.');
        // A bot key limited to some conversations sees and reaches only those; every action it takes is logged.
        const botMay=c=>!user.bot_id||!user.bot_conversations||user.bot_conversations.includes(c.id);
        const botLog=(d,action,conversationId,title)=>d.query('INSERT INTO manager_bot_activity(key_id,action,conversation_id,title) VALUES($1,$2,$3,$4)',[user.bot_id,action,conversationId,title?String(title).slice(0,200):null]);
        // Product access: admins and members without a list see every product; a list limits tasks and notes to it.
        const sees=product=>isAdmin(member)||!member.products||member.products.includes(product||'');
        // Someone else's shared session: admins always; everyone only when the workspace says so.
        const seesSession=c=>c.owner_id===user.id||!c.source_key||isAdmin(member)||company.session_visibility==='all';
        const owner=()=>requireThat(member.role==='owner',403,'Owner access required.');
        if(!tail && req.method==='GET') return {company:publicCompany({...company,...member,id:company.id})};
        if(!tail && req.method==='PATCH') {
          owner(); const name=input.name===undefined?company.name:text(input.name,'Company name');
          const visibility=input.defaultVisibility===undefined?company.default_visibility:enumValue(input.defaultVisibility,['owner','company'],'visibility');
          requireThat(input.allowCompanySharing===undefined||typeof input.allowCompanySharing==='boolean',400,'Invalid sharing policy.');
          const sharing=input.allowCompanySharing??company.allow_company_sharing;
          requireThat(sharing||visibility==='owner',400,'Default visibility must be owner when sharing is disabled.');
          const sessionVisibility=input.sessionVisibility===undefined?company.session_visibility:enumValue(input.sessionVisibility,['admins','all'],'session visibility');
          await db.query('UPDATE manager_companies SET name=$1,default_visibility=$2,allow_company_sharing=$3,session_visibility=$5 WHERE id=$4',[name,visibility,sharing,companyId,sessionVisibility]);
          // Turning sharing off immediately makes existing conversations private, including desktop reads.
          if(!sharing) await db.query("UPDATE manager_conversations SET visibility='owner',updated_at=now() WHERE company_id=$1 AND visibility='company'",[companyId]);
          await audit(db,companyId,user.id,'company.updated',companyId);return {ok:true};
        }
        if(tail==='/members'&&req.method==='GET') {
          const {rows}=await db.query(`SELECT u.id,u.name,u.email,m.role,m.classification,m.products,(SELECT s.app_version FROM manager_sessions s WHERE s.user_id=u.id AND s.app_version IS NOT NULL ORDER BY s.seen_at DESC NULLS LAST LIMIT 1) AS app_version,
            (SELECT max(s.seen_at) FROM manager_sessions s WHERE s.user_id=u.id) AS app_seen FROM manager_memberships m JOIN manager_users u ON u.id=m.user_id WHERE m.company_id=$1 ORDER BY u.name`,[companyId]);
          return {members:rows};
        }
        if(/^\/members\/[^/]+$/.test(tail)&&['PATCH','DELETE'].includes(req.method)) {
          admin();const targetId=uuid(tail.split('/').at(-1));
          const {rows:[target]}=await db.query('SELECT * FROM manager_memberships WHERE company_id=$1 AND user_id=$2',[companyId,targetId]);
          requireThat(target,404,'Member not found.');
          requireThat(member.role==='owner'||(target.role!=='owner'&&target.role!=='admin'),403,'Only owners can modify administrators or owners.');
          const role=req.method==='DELETE'?null:enumValue(input.role??target.role,ROLES,'role');
          if(role==='owner'||role==='admin') owner();
          if(target.role==='owner'&&role!=='owner') {
            const {rows:[count]}=await db.query("SELECT count(*)::int AS n FROM manager_memberships WHERE company_id=$1 AND role='owner'",[companyId]);
            requireThat(count.n>1,409,'A company must retain at least one owner.');
          }
          if(req.method==='DELETE') {
            await db.query('DELETE FROM manager_memberships WHERE company_id=$1 AND user_id=$2',[companyId,targetId]);
            await db.query('UPDATE manager_invites SET revoked_at=now() WHERE company_id=$1 AND email=(SELECT email FROM manager_users WHERE id=$2) AND accepted_at IS NULL AND revoked_at IS NULL',[companyId,targetId]);
          }
          else {
            const products=input.products===undefined?target.products:input.products===null?null:(requireThat(Array.isArray(input.products)&&input.products.length<=50&&input.products.every(x=>typeof x==='string'&&x.length<=100),400,'Invalid products.'),input.products.map(x=>x.trim()).filter(Boolean));
            await db.query('UPDATE manager_memberships SET role=$1,classification=$2,products=$5 WHERE company_id=$3 AND user_id=$4',[role,enumValue(input.classification??target.classification,CLASSIFICATIONS,'classification'),companyId,targetId,products]);
          }
          if(['owner','admin'].includes(target.role)&&!['owner','admin'].includes(role))await db.query('UPDATE manager_invites SET revoked_at=now() WHERE company_id=$1 AND created_by=$2 AND accepted_at IS NULL AND revoked_at IS NULL',[companyId,targetId]);
          await audit(db,companyId,user.id,req.method==='DELETE'?'member.removed':'member.updated',targetId);return {ok:true};
        }
        if(tail==='/invites'&&req.method==='POST') {
          requireThat(member.role!=='viewer',403,'Viewers cannot invite people.');const accountEmail=email(input.email),role=enumValue(input.role??'member',['admin','member','viewer'],'role'),classification=enumValue(input.classification??'general',CLASSIFICATIONS,'classification');
          if(role==='admin') owner();
          const {rowCount:privilegedInvites}=await db.query("SELECT id FROM manager_invites WHERE company_id=$1 AND email=$2 AND role='admin' AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at>now()",[companyId,accountEmail]);
          if(privilegedInvites)owner();
          const token=opaqueToken(),id=randomUUID();
          // Reissuing an invitation invalidates previous unused tokens for that address.
          await db.query('UPDATE manager_invites SET revoked_at=now() WHERE company_id=$1 AND email=$2 AND accepted_at IS NULL AND revoked_at IS NULL',[companyId,accountEmail]);
          await db.query("INSERT INTO manager_invites(id,company_id,email,role,classification,token_hash,created_by,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,now()+interval '48 hours')",[id,companyId,accountEmail,role,classification,digest(token),user.id]);
          await audit(db,companyId,user.id,'invite.created',id);return {id,token,inviteUrl:`${origin}/#invite=${token}`,expiresInHours:48};
        }
        if(tail==='/invites/link'&&req.method==='POST') {
          requireThat(member.role!=='viewer',403,'Viewers cannot invite people.');
          const role=enumValue(input.role??'member',['admin','member','viewer'],'role');if(role==='admin')owner();
          const hours=Math.min(168,Math.max(1,Number.isInteger(input.hours)?input.hours:24)),token=opaqueToken(),id=randomUUID();
          await db.query(`INSERT INTO manager_invite_links(id,company_id,token_hash,role,created_by,expires_at) VALUES($1,$2,$3,$4,$5,now()+make_interval(hours=>$6))`,[id,companyId,digest(token),role,user.id,hours]);
          await audit(db,companyId,user.id,'invite_link.created',id);
          return {id,token,inviteUrl:`${origin}/#invite=${token}`,expiresInHours:hours,role};
        }
        if(tail==='/invites'&&req.method==='GET') {
          admin();const {rows}=await db.query('SELECT id,email,role,classification,expires_at,accepted_at,revoked_at FROM manager_invites WHERE company_id=$1 ORDER BY created_at DESC LIMIT 100',[companyId]);return {invites:rows};
        }
        if(/^\/invites\/[^/]+$/.test(tail)&&req.method==='DELETE') {
          admin();const id=uuid(tail.split('/').at(-1));
          const {rows:[target]}=await db.query('SELECT role FROM manager_invites WHERE id=$1 AND company_id=$2',[id,companyId]);
          if(target?.role==='admin')owner();
          await db.query('UPDATE manager_invites SET revoked_at=now() WHERE id=$1 AND company_id=$2',[id,companyId]);
          await audit(db,companyId,user.id,'invite.revoked',id);return {ok:true};
        }
        if(tail==='/catalog'&&req.method==='GET') {
          const {rows}=await db.query('SELECT catalog_id,subject_type,subject FROM manager_catalog_assignments WHERE company_id=$1',[companyId]);
          return {catalog:entries.map(entry=>{
            const assignments=rows.filter(a=>a.catalog_id===entry.id),assigned=catalogAllowed(assignments,member);
            return {...entry,assigned,installation:assigned?entry.installation:null,...(isAdmin(member)?{assignments}: {})};
          })};
        }
        const assignment=tail.match(/^\/catalog\/([^/]+)\/assignments$/);
        if(assignment&&req.method==='PUT') {
          admin();requireThat(entries.some(e=>e.id===assignment[1]),404,'Catalog item not allowlisted.');
          requireThat(Array.isArray(input.roles)&&Array.isArray(input.classifications)&&input.roles.length<=ROLES.length&&input.classifications.length<=CLASSIFICATIONS.length,400,'Provide roles and classifications arrays.');
          const assignedRoles=[...new Set(input.roles.map(r=>enumValue(r,ROLES,'role')))];
          const classes=[...new Set(input.classifications.map(c=>enumValue(c,CLASSIFICATIONS,'classification')))];
          await db.query('DELETE FROM manager_catalog_assignments WHERE company_id=$1 AND catalog_id=$2',[companyId,assignment[1]]);
          for(const [type,subjects] of [['role',assignedRoles],['classification',classes]])for(const subject of subjects)await db.query('INSERT INTO manager_catalog_assignments(company_id,catalog_id,subject_type,subject) VALUES($1,$2,$3,$4)',[companyId,assignment[1],type,subject]);
          await audit(db,companyId,user.id,'catalog.assigned',assignment[1]);return {ok:true};
        }
        if(tail==='/conversations'&&req.method==='GET') {
          const before=url.searchParams.get('before');if(before)requireThat(Number.isFinite(Date.parse(before)),400,'Invalid before cursor.');
          const {rows}=await db.query(`SELECT c.*,u.name AS owner_name FROM manager_conversations c JOIN manager_users u ON u.id=c.owner_id WHERE company_id=$1 AND (owner_id=$2 OR (visibility='company' AND $3=ANY(allowed_roles))) AND ($4::timestamptz IS NULL OR updated_at<$4) ORDER BY updated_at DESC,c.id DESC LIMIT 100`,[companyId,user.id,member.role,before||null]);
          const shown=rows.filter(r=>(!user.bot_id||r.visibility==='company')&&seesSession(r)&&botMay(r));
          if(user.bot_id)await botLog(db,'list',null,`${shown.length} sessions`);
          return {conversations:shown.map(publicConversation)};
        }
        if(tail==='/conversations'&&req.method==='POST') {
          requireThat(member.role!=='viewer',403,'Viewers cannot create conversations.');
          const id=randomUUID(),title=text(input.title,'Title'),visibility=enumValue(input.visibility??company.default_visibility,['owner','company'],'visibility');
          requireThat(visibility!=='company'||company.allow_company_sharing,403,'Company sharing is disabled.');
          const {rows:[row]}=await db.query('INSERT INTO manager_conversations(id,company_id,owner_id,title,visibility,allowed_roles) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',[id,companyId,user.id,title,visibility,input.allowedRoles?roles(input.allowedRoles):ROLES]);
          return {conversation:publicConversation(row)};
        }
        // A TerminAI tab as a conversation: made the first time, then its title, folder, status and heartbeat.
        const tabConv=tail.match(/^\/conversations\/tab\/([A-Za-z0-9_-]{1,120})$/);
        if(tabConv&&req.method==='PUT') {
          requireThat(member.role!=='viewer',403,'Viewers cannot share conversations.');
          const title=text(input.title,'Title'),place=typeof input.place==='string'?input.place.slice(0,300):null,status=typeof input.status==='string'?input.status.slice(0,20):null;
          const want=input.visibility===undefined?null:enumValue(input.visibility,['owner','company'],'visibility');
          requireThat(want!=='company'||company.allow_company_sharing,403,'Company sharing is disabled.');
          const {rows:[row]}=await db.query(`INSERT INTO manager_conversations(id,company_id,owner_id,title,visibility,source_key,place,tab_status,seen_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,now())
            ON CONFLICT (owner_id,source_key) WHERE source_key IS NOT NULL DO UPDATE SET title=$4,place=$7,tab_status=$8,seen_at=now(),visibility=coalesce($9,manager_conversations.visibility)
            RETURNING *`,[randomUUID(),companyId,user.id,title,want??'company',tabConv[1],place,status,want]);
          requireThat(row.company_id===companyId,409,'That tab is shared in another workspace.');
          return {conversation:publicConversation({...row,owner_name:user.name})};
        }
        // Agent messages: from a tab (or none) to a tab-conversation someone can read; its owner's Mac takes them.
        if(tail==='/agent'&&req.method==='POST') {
          requireThat(member.role!=='viewer',403,'Viewers cannot message sessions.');
          const to=uuid(input.to),content=text(input.content,'Message',20000),from=input.from?uuid(input.from):null,replyTo=input.replyTo?uuid(input.replyTo):null;
          const {rows:[target]}=await db.query('SELECT * FROM manager_conversations WHERE id=$1 AND company_id=$2 AND source_key IS NOT NULL',[to,companyId]);
          requireThat(target&&canReadConversation(target,member,user.id)&&seesSession(target)&&(!user.bot_id||target.visibility==='company'||target.owner_id===user.id)&&botMay(target),404,'That session is not shared with you.');
          if(user.bot_id){
            requireThat(user.bot_scope!=='read',403,'This bot key is read-only.');
            if(user.bot_scope==='reply'){const {rowCount}=await db.query('SELECT 1 FROM manager_bot_asks WHERE key_id=$1 AND conversation_id=$2 AND until>now()',[user.bot_id,to]);requireThat(rowCount,403,'This bot key can only answer a question that session asked it in the last 30 minutes.');}
            await botLog(db,'message',to,target.title);
          }
          if(from){const {rowCount}=await db.query('SELECT 1 FROM manager_conversations WHERE id=$1 AND owner_id=$2',[from,user.id]);requireThat(rowCount,400,'Not your session.');}
          if(replyTo){const {rowCount}=await db.query('SELECT 1 FROM manager_agent_messages m JOIN manager_conversations c ON c.id=m.to_conversation WHERE m.id=$1 AND c.owner_id=$2',[replyTo,user.id]);requireThat(rowCount,404,'No such message to answer.');}
          await limit(pool,`agent:${user.id}`,120,3600);
          const id=randomUUID();
          await db.query('INSERT INTO manager_agent_messages(id,company_id,from_user,from_conversation,to_conversation,reply_to,content,from_bot,from_bot_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[id,companyId,user.id,from,to,replyTo,content,user.bot_name||null,user.bot_id||null]);
          return {id,to,live:!!target.seen_at&&Date.now()-new Date(target.seen_at).getTime()<120000};
        }
        // Bot keys: made by any member for their own bots, listed and revoked by them.
        if(tail==='/bots'&&req.method==='GET'){const {rows}=await db.query('SELECT id,name,created_at,expires_at,last_used_at,scope,approval,conversations FROM manager_bot_keys WHERE company_id=$1 AND user_id=$2 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>now()) ORDER BY created_at DESC',[companyId,user.id]);return {bots:rows};}
        if(tail==='/bots'&&req.method==='POST'){
          requireThat(member.role!=='viewer'&&!user.bot_id,403,'Not allowed.');
          const name=text(input.name,'Name',60),days=Number.isInteger(input.days)&&input.days>0?Math.min(input.days,365):null,token=opaqueToken(),id=randomUUID(),limits=botLimits(input,{scope:'full',approval:null,conversations:null});
          await db.query(`INSERT INTO manager_bot_keys(id,company_id,user_id,name,token_hash,scope,approval,conversations,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,${days?"now()+make_interval(days=>$9)":"NULL"})`,[id,companyId,user.id,name,digest(token),limits.scope,limits.approval,limits.conversations,...(days?[days]:[])]);
          await audit(db,companyId,user.id,'bot.created',id);
          return {id,name,key:`tbot_${token}`,api:`${origin}/api/companies/${companyId}`};
        }
        const botMatch=tail.match(/^\/bots\/([0-9a-f-]{36})$/);
        // Its limits, changed by its maker: access, approval, conversations, and a new expiry (days from now, 0: never).
        if(botMatch&&req.method==='PATCH'){
          requireThat(!user.bot_id,403,'Not allowed.');
          const {rows:[k]}=await db.query('SELECT * FROM manager_bot_keys WHERE id=$1 AND company_id=$2 AND user_id=$3 AND revoked_at IS NULL',[botMatch[1],companyId,user.id]);requireThat(k,404,'No such bot key.');
          const l=botLimits(input,k),days=input.days===undefined?undefined:Number.isInteger(input.days)&&input.days>=0?Math.min(input.days,365):(requireThat(false,400,'Invalid expiry.'),0);
          await db.query(`UPDATE manager_bot_keys SET scope=$1,approval=$2,conversations=$3${days===undefined?'':days?",expires_at=now()+make_interval(days=>$5)":",expires_at=NULL"} WHERE id=$4`,[l.scope,l.approval,l.conversations,k.id,...(days?[days]:[])]);
          return {ok:true};
        }
        // A question this Mac sent the bot from a conversation: a reply-only bot may answer into it for 30 minutes.
        const askMatch=tail.match(/^\/bots\/([0-9a-f-]{36})\/asked$/);
        if(askMatch&&req.method==='POST'){
          requireThat(!user.bot_id,403,'Not allowed.');
          const cid=uuid(input.conversation),{rowCount:own}=await db.query('SELECT 1 FROM manager_conversations WHERE id=$1 AND company_id=$2 AND owner_id=$3',[cid,companyId,user.id]);requireThat(own,404,'Not your session.');
          const {rowCount}=await db.query('SELECT 1 FROM manager_bot_keys WHERE id=$1 AND company_id=$2 AND user_id=$3 AND revoked_at IS NULL',[askMatch[1],companyId,user.id]);requireThat(rowCount,404,'No such bot key.');
          await db.query("INSERT INTO manager_bot_asks(key_id,conversation_id,until) VALUES($1,$2,now()+interval '30 minutes') ON CONFLICT (key_id,conversation_id) DO UPDATE SET until=excluded.until",[askMatch[1],cid]);
          return {ok:true};
        }
        const actMatch=tail.match(/^\/bots\/([0-9a-f-]{36})\/activity$/);
        if(actMatch&&req.method==='GET'){
          requireThat(!user.bot_id,403,'Not allowed.');
          const {rows}=await db.query('SELECT a.action,a.conversation_id,a.title,a.at FROM manager_bot_activity a JOIN manager_bot_keys k ON k.id=a.key_id WHERE a.key_id=$1 AND k.user_id=$2 ORDER BY a.at DESC LIMIT 200',[actMatch[1],user.id]);
          return {activity:rows};
        }
        if(botMatch&&req.method==='DELETE'){await db.query('UPDATE manager_bot_keys SET revoked_at=now() WHERE id=$1 AND company_id=$2 AND user_id=$3',[botMatch[1],companyId,user.id]);return {ok:true};}
        if(tail==='/agent/inbox'&&req.method==='GET') {
          const {rows}=await db.query(`SELECT m.id,m.content,m.created_at,m.reply_to,m.to_conversation,t.source_key,(m.from_user=t.owner_id AND m.from_bot IS NULL) AS self,m.from_bot,u.name AS from_name,f.title AS from_title,m.from_conversation,bk.approval AS bot_approval,bk.scope AS bot_scope
            FROM manager_agent_messages m JOIN manager_conversations t ON t.id=m.to_conversation JOIN manager_users u ON u.id=m.from_user LEFT JOIN manager_conversations f ON f.id=m.from_conversation LEFT JOIN manager_bot_keys bk ON bk.id=m.from_bot_key
            WHERE m.company_id=$1 AND t.owner_id=$2 AND m.delivered_at IS NULL AND m.created_at>now()-interval '1 day' ORDER BY m.created_at LIMIT 50`,[companyId,user.id]);
          return {messages:rows.map(r=>({id:r.id,content:r.content,createdAt:r.created_at,replyTo:r.reply_to,to:r.to_conversation,tab:r.source_key,fromName:r.from_bot?`${r.from_bot} (${r.from_name}'s bot)`:r.from_name,bot:!!r.from_bot,botApproval:r.bot_approval??null,botScope:r.bot_scope??null,fromTitle:r.from_title,from:r.from_conversation,self:r.self}))};
        }
        const agentMsg=tail.match(/^\/agent\/([^/]+)\/(delivered|replies)$/);
        if(agentMsg) {
          const id=uuid(agentMsg[1]);
          const {rows:[m]}=await db.query('SELECT m.*,t.owner_id AS to_owner FROM manager_agent_messages m JOIN manager_conversations t ON t.id=m.to_conversation WHERE m.id=$1 AND m.company_id=$2',[id,companyId]);
          requireThat(m&&(m.from_user===user.id||m.to_owner===user.id),404,'Message not found.');
          if(agentMsg[2]==='delivered'&&req.method==='POST'){requireThat(m.to_owner===user.id,403,'Not yours.');await db.query('UPDATE manager_agent_messages SET delivered_at=now() WHERE id=$1',[id]);return {ok:true};}
          if(agentMsg[2]==='replies'&&req.method==='GET'){
            const {rows}=await db.query('SELECT r.id,r.content,r.created_at,u.name AS from_name FROM manager_agent_messages r JOIN manager_users u ON u.id=r.from_user WHERE r.reply_to=$1 ORDER BY r.created_at',[id]);
            return {delivered:!!m.delivered_at,replies:rows.map(r=>({id:r.id,content:r.content,createdAt:r.created_at,fromName:r.from_name}))};
          }
        }
        const conv=tail.match(/^\/conversations\/([^/]+)(\/messages)?$/);
        if(conv) {
          const conversationId=uuid(conv[1]);
          const {rows:[conversation]}=await db.query('SELECT * FROM manager_conversations WHERE id=$1 AND company_id=$2',[conversationId,companyId]);
          requireThat(conversation&&canReadConversation(conversation,member,user.id)&&seesSession(conversation)&&(!user.bot_id||conversation.visibility==='company')&&botMay(conversation),404,'Conversation not found.');
          if(user.bot_id&&req.method==='GET')await botLog(db,'read',conversationId,conversation.title);
          if(!conv[2]&&req.method==='GET')return {conversation:publicConversation(conversation)};
          // Its owner deletes it for good: its messages, and the agent messages to and from it, go with it.
          if(!conv[2]&&req.method==='DELETE'){requireThat(conversation.owner_id===user.id,403,'Only its owner can delete it.');await db.query('DELETE FROM manager_conversations WHERE id=$1',[conversationId]);return {ok:true};}
          if(!conv[2]&&req.method==='PATCH') {
            requireThat(conversation.owner_id===user.id&&member.role!=='viewer',403,'Only the conversation owner can change its visibility or title.');
            const visibility=enumValue(input.visibility??conversation.visibility,['owner','company'],'visibility');
            requireThat(visibility!=='company'||company.allow_company_sharing,403,'Company sharing is disabled.');
            const {rows:[row]}=await db.query('UPDATE manager_conversations SET title=$1,visibility=$2,allowed_roles=$3,updated_at=now() WHERE id=$4 AND company_id=$5 RETURNING *',[input.title===undefined?conversation.title:text(input.title,'Title'),visibility,input.allowedRoles?roles(input.allowedRoles):conversation.allowed_roles,conversationId,companyId]);
            return {conversation:publicConversation(row)};
          }
          if(conv[2]&&req.method==='GET') {
            const after=url.searchParams.get('after');let cursor=null;
            if(after){uuid(after);const {rows:[row]}=await db.query('SELECT id,created_at::text AS created_at FROM manager_messages WHERE id=$1 AND conversation_id=$2 AND company_id=$3',[after,conversationId,companyId]);requireThat(row,400,'Invalid message cursor.');cursor=row;}
            const {rows}=cursor
              ? await db.query('SELECT m.*,u.name AS author_name FROM manager_messages m JOIN manager_users u ON u.id=m.author_id WHERE conversation_id=$1 AND company_id=$2 AND (m.created_at,m.id)>($3,$4::uuid) ORDER BY m.created_at,m.id LIMIT 200',[conversationId,companyId,cursor.created_at,cursor.id])
              : await db.query('SELECT recent.*,u.name AS author_name FROM (SELECT * FROM manager_messages WHERE conversation_id=$1 AND company_id=$2 ORDER BY created_at DESC,id DESC LIMIT 200) recent JOIN manager_users u ON u.id=recent.author_id ORDER BY recent.created_at,recent.id',[conversationId,companyId]);
            return {messages:rows.map(publicMessage),nextCursor:rows.at(-1)?.id||null,hasMore:!!cursor&&rows.length===200};
          }
          if(conv[2]&&req.method==='POST') {
            requireThat(canWriteConversation(conversation,member,user.id),403,'Read-only conversation.');
            const content=text(input.content,'Message',64000),kind=enumValue(input.kind??'user',['user','assistant','note'],'message kind'),clientId=input.clientMessageId?uuid(input.clientMessageId):null;
            const {rows:[inserted]}=await db.query('INSERT INTO manager_messages(id,conversation_id,company_id,author_id,kind,content,client_message_id) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(conversation_id,author_id,client_message_id) DO NOTHING RETURNING *',[randomUUID(),conversationId,companyId,user.id,kind,content,clientId]);
            let row=inserted;
            if(!row){const existing=await db.query('SELECT * FROM manager_messages WHERE conversation_id=$1 AND author_id=$2 AND client_message_id=$3',[conversationId,user.id,clientId]);row=existing.rows[0];requireThat(row.content===content&&row.kind===kind,409,'Client message ID was already used for different content.');}
            if(inserted)await db.query('UPDATE manager_conversations SET updated_at=now() WHERE id=$1',[conversationId]);
            return {message:publicMessage({...row,author_name:user.name}),deduplicated:!inserted};
          }
        }
        // Notes: a private list per person (only its owner ever reads it) and the team's shared board.
        if(tail==='/notes'&&req.method==='GET') {
          const {rows}=await db.query(`SELECT n.*,u.name AS updated_by_name,(SELECT coalesce(json_agg(json_build_object('id',f.id,'name',f.name,'mime',f.mime,'size',f.size,'createdAt',f.created_at) ORDER BY f.created_at),'[]')
              FROM manager_note_files f WHERE f.note_id=n.id) AS files FROM manager_notes n LEFT JOIN manager_users u ON u.id=n.updated_by
            WHERE n.company_id=$1 AND (n.visibility='company' OR n.owner_id=$2) ORDER BY n.position,n.created_at LIMIT 2000`,[companyId,user.id]);
          return {notes:rows.filter(n=>n.visibility==='private'||sees(n.product)).map(publicNote)};
        }
        const assignee=async value=>{
          if(value===null||value===undefined||value==='')return null;
          const {rowCount}=await db.query('SELECT 1 FROM manager_memberships WHERE company_id=$1 AND user_id=$2',[companyId,uuid(value)]);
          requireThat(rowCount,400,'That person is not in this team.');return value;
        };
        if(tail==='/notes'&&req.method==='POST') {
          const visibility=enumValue(input.visibility??'private',['private','company'],'visibility');
          requireThat(visibility==='private'||member.role!=='viewer',403,'Viewers cannot add to the team board.');
          const {rows:[last]}=await db.query('SELECT coalesce(max(position),0)+1 AS p FROM manager_notes WHERE company_id=$1',[companyId]);
          const kind=enumValue(input.kind??'card',['card','doc'],'note kind');
          const {rows:[row]}=await db.query('INSERT INTO manager_notes(id,company_id,owner_id,visibility,title,body,assignee_id,position,updated_by,kind,product) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$3,$9,$10) RETURNING *',
            [randomUUID(),companyId,user.id,visibility,kind==='doc'&&!input.title?'New note':text(input.title,'Title',500),typeof input.body==='string'?input.body.slice(0,kind==='doc'?100000:20000):'',visibility==='company'&&kind==='card'?await assignee(input.assigneeId):null,last.p,kind,typeof input.product==='string'?input.product.trim().slice(0,100):'']);
          return {note:publicNote({...row,updated_by_name:user.name})};
        }
        const noteMatch=tail.match(/^\/notes\/([^/]+)$/);
        if(noteMatch&&['PATCH','DELETE'].includes(req.method)) {
          const {rows:[note]}=await db.query('SELECT * FROM manager_notes WHERE id=$1 AND company_id=$2 FOR UPDATE',[uuid(noteMatch[1]),companyId]);
          requireThat(note&&(note.visibility==='company'||note.owner_id===user.id),404,'Note not found.');
          requireThat(note.visibility==='private'||member.role!=='viewer',403,'Viewers cannot change the team board.');
          if(req.method==='DELETE'){requireThat(note.owner_id===user.id||isAdmin(member),403,'Only its author or an admin can delete it.');await db.query('DELETE FROM manager_notes WHERE id=$1',[note.id]);return {ok:true};}
          const visibility=input.visibility===undefined?note.visibility:enumValue(input.visibility,['private','company'],'visibility');
          requireThat(visibility===note.visibility||note.owner_id===user.id,403,'Only its author can move it between private and team.');
          const {rows:[row]}=await db.query('UPDATE manager_notes SET title=$1,body=$2,status=$3,assignee_id=$4,position=$5,visibility=$6,updated_by=$7,updated_at=now(),product=$9 WHERE id=$8 RETURNING *',[
            input.title===undefined?note.title:text(input.title,'Title',500),
            input.body===undefined?note.body:String(input.body).slice(0,note.kind==='doc'?100000:20000),
            input.status===undefined?note.status:enumValue(input.status,['open','done'],'status'),
            visibility==='private'?null:input.assigneeId===undefined?note.assignee_id:await assignee(input.assigneeId),
            input.position===undefined?note.position:(requireThat(Number.isFinite(input.position),400,'Invalid position.'),input.position),
            visibility,user.id,note.id,input.product===undefined?note.product||'':String(input.product).trim().slice(0,100)]);
          const {rows:files}=await db.query('SELECT id,name,mime,size,created_at FROM manager_note_files WHERE note_id=$1 ORDER BY created_at',[note.id]);
          return {note:publicNote({...row,updated_by_name:user.name,files:files.map(publicFile)})};
        }
        // The work log (manager_worklogs): everyone in the workspace reads every day; each writes only their own column's.
        const logDay=tail.match(/^\/worklog\/(\d{4}-\d{2}-\d{2})$/);
        if(logDay&&req.method==='GET'){
          const {rows}=await db.query('SELECT person,data FROM manager_worklogs WHERE company_id=$1 AND day=$2',[companyId,logDay[1]]);
          return {day:logDay[1],people:Object.fromEntries(rows.map(r=>[r.person,r.data]))};
        }
        if(tail==='/worklog'&&req.method==='GET'){
          const {rows}=await db.query("SELECT to_char(day,'YYYY-MM-DD') AS day,array_agg(person) AS people FROM manager_worklogs WHERE company_id=$1 GROUP BY day ORDER BY day DESC LIMIT 120",[companyId]);
          return {days:rows};
        }
        if(logDay&&req.method==='DELETE'){
          const {rows:[col]}=await db.query('SELECT key FROM manager_task_people WHERE company_id=$1 AND user_id=$2',[companyId,user.id]);
          if(col)await db.query('DELETE FROM manager_worklogs WHERE company_id=$1 AND person=$2 AND day=$3',[companyId,col.key,logDay[1]]);
          return {ok:true};
        }
        // Everything this person's Macs uploaded here: their sessions (with messages) and their work log days.
        if(tail==='/uploads'&&req.method==='DELETE'){
          const {rowCount:sessions}=await db.query('DELETE FROM manager_conversations WHERE company_id=$1 AND owner_id=$2 AND source_key IS NOT NULL',[companyId,user.id]);
          const {rows:[col]}=await db.query('SELECT key FROM manager_task_people WHERE company_id=$1 AND user_id=$2',[companyId,user.id]);
          const {rowCount:days}=col?await db.query('DELETE FROM manager_worklogs WHERE company_id=$1 AND person=$2',[companyId,col.key]):{rowCount:0};
          await audit(db,companyId,user.id,'uploads.deleted',null);
          return {ok:true,sessions,days};
        }
        if(logDay&&req.method==='PUT'){
          const {rows:[col]}=await db.query('SELECT key FROM manager_task_people WHERE company_id=$1 AND user_id=$2',[companyId,user.id]);
          requireThat(col,409,'Choose your To-do column on this Mac first.');
          requireThat(input.data&&typeof input.data==='object'&&!Array.isArray(input.data),400,'Invalid log.');
          requireThat(JSON.stringify(input.data).length<=400000,413,'That log is too long.');
          await db.query(`INSERT INTO manager_worklogs(company_id,person,day,data) VALUES($1,$2,$3,$4)
            ON CONFLICT (company_id,person,day) DO UPDATE SET data=$4,updated_at=now()`,[companyId,col.key,logDay[1],{...input.data,person:col.key,day:logDay[1]}]);
          return {ok:true};
        }
        // The To-do's shared page (see manager_tasks). Whoever is in the workspace reads it; viewers cannot change it.
        if(tail==='/tasks'&&req.method==='GET') {
          const {rows:people}=await db.query('SELECT p.key,u.id,u.name FROM manager_task_people p JOIN manager_users u ON u.id=p.user_id WHERE p.company_id=$1',[companyId]);
          const {rows}=await db.query('SELECT id,data,updated_at,deleted_at,changed_by FROM manager_tasks WHERE company_id=$1 ORDER BY updated_at LIMIT 5000',[companyId]);
          return { tasks:rows.filter(r=>!r.deleted_at&&sees(r.data.product)).map(r=>r.data), deleted:rows.filter(r=>r.deleted_at).map(r=>({id:r.id,deletedAt:r.deleted_at,by:people.find(p=>p.id===r.changed_by)?.key??null})),
            people:Object.fromEntries(people.map(p=>[p.key,{id:p.id,name:p.name}])), me:people.find(p=>p.id===user.id)?.key??null };
        }
        if(tail==='/tasks/people'&&req.method==='PUT') {
          const key=enumValue(input.key,['ilai','livio'],'column');
          await db.query('DELETE FROM manager_task_people WHERE company_id=$1 AND user_id=$2',[companyId,user.id]);
          await db.query('INSERT INTO manager_task_people(company_id,key,user_id) VALUES($1,$2,$3) ON CONFLICT (company_id,key) DO UPDATE SET user_id=$3',[companyId,key,user.id]);
          return {ok:true};
        }
        const taskMatch=tail.match(/^\/tasks\/([A-Za-z0-9_-]{1,80})$/);
        if(taskMatch&&['PUT','DELETE'].includes(req.method)) {
          requireThat(member.role!=='viewer',403,'Viewers cannot change the To-do.');
          if(req.method==='PUT')requireThat(sees(input.task?.product),403,'You have no access to that product.');
          const id=taskMatch[1];
          if(req.method==='DELETE'){await db.query('UPDATE manager_tasks SET deleted_at=now(),updated_at=now(),changed_by=$3 WHERE company_id=$1 AND id=$2',[companyId,id,user.id]);return {ok:true};}
          const task=input.task;
          requireThat(task&&typeof task==='object'&&!Array.isArray(task)&&task.id===id,400,'Invalid task.');
          requireThat(typeof task.title==='string'&&task.title.trim()&&task.title.length<=500,400,'A task needs a title.');
          requireThat(['open','doing','done'].includes(task.status),400,'Invalid status.');
          requireThat([null,'ilai','livio','both'].includes(task.assignee??null),400,'Invalid column.');
          requireThat(JSON.stringify(task).length<=60000,413,'That task is too long.');
          // A Mac copying its repo keeps the time the task really changed; an edit made here (phone, web) is now.
          const data={...task,assignee:task.assignee??null,updatedAt:typeof task.updatedAt==='string'&&!Number.isNaN(Date.parse(task.updatedAt))?task.updatedAt:new Date().toISOString()};
          await db.query(`INSERT INTO manager_tasks(company_id,id,data,changed_by) VALUES($1,$2,$3,$4)
            ON CONFLICT (company_id,id) DO UPDATE SET data=$3,updated_at=now(),deleted_at=NULL,changed_by=$4`,[companyId,id,data,user.id]);
          return {task:data};
        }
        if(tail==='/audit'&&req.method==='GET'){admin();const {rows}=await db.query('SELECT id,actor_id,action,target_id,created_at FROM manager_audit WHERE company_id=$1 ORDER BY created_at DESC LIMIT 100',[companyId]);return {events:rows};}
        throw new HttpError(404,'Not found.');
      });
      return json(res,200,result);
    } catch(error) {
      const status=error instanceof HttpError?error.status:error.code==='23505'?409:500;
      if(status===500)console.error('Manager request failed', {code:error.code||error.name});
      if(!res.headersSent)json(res,status,{error:status===500?'Request failed. Please try again.':status===409&&!(error instanceof HttpError)?'Record already exists.':error.message},status===429?{'Retry-After':'900'}:{});
      else res.end();
    }
  };
}
