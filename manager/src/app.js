import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { transaction } from './db.js';
import { catalog } from './catalog.js';
import { ROLES, CLASSIFICATIONS, HttpError, requireThat, opaqueToken, digest, safeEqual, email, text, enumValue, uuid, hashPassword, verifyPassword, isAdmin, canReadConversation, canWriteConversation, catalogAllowed } from './security.js';

const unsafe = method => !['GET', 'HEAD', 'OPTIONS'].includes(method);
const publicUser = user => ({ id: user.id, email: user.email, name: user.name });
const publicCompany = row => ({ id: row.id, name: row.name, role: row.role, classification: row.classification, defaultVisibility: row.default_visibility, allowCompanySharing: row.allow_company_sharing });
const publicConversation = row => ({ id: row.id, companyId: row.company_id, ownerId: row.owner_id, title: row.title, visibility: row.visibility, allowedRoles: row.allowed_roles, createdAt: row.created_at, updatedAt: row.updated_at });
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
  const { rows: [session] } = await db.query(`INSERT INTO manager_sessions(id,token_hash,user_id,client,expires_at) VALUES($1,$2,$3,$4,now()+interval '7 days') RETURNING id,expires_at`, [randomUUID(), digest(token), userId, client]);
  return { token, sessionId: session.id, expiresAt: session.expires_at };
}
export function createApp(pool, config) {
  const origin = new URL(config.publicOrigin).origin;
  requireThat(origin === config.publicOrigin && (origin.startsWith('https:') || ['localhost','127.0.0.1','[::1]'].includes(new URL(origin).hostname)), 500, 'PUBLIC_ORIGIN must be an HTTPS origin (HTTP allowed only on localhost).');
  const secure = origin.startsWith('https:');
  const cookieName = secure ? '__Host-terminai_session' : 'terminai_session';
  const cookie = (value, age = 604800) => `${cookieName}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${secure ? '; Secure' : ''}`;
  const entries = catalog(config);
  function json(res, status, value, headers = {}) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers }); res.end(JSON.stringify(value)); }
  async function auth(req) {
    const bearer = req.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
    const cookieToken = (req.headers.cookie || '').split(';').map(p => p.trim()).find(p => p.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
    const token = bearer || cookieToken;
    requireThat(token && /^[A-Za-z0-9_-]{43}$/.test(token), 401, 'Sign in to continue.');
    if (!bearer && unsafe(req.method)) requireThat(req.headers.origin === origin, 403, 'Invalid request origin.');
    const { rows: [user] } = await pool.query(`SELECT u.*,s.id AS session_id FROM manager_sessions s JOIN manager_users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>now()`, [digest(token)]);
    requireThat(user, 401, 'Session expired. Sign in again.');
    return user;
  }
  async function signedInResponse(req, res, db, user, input) {
    const client = input.client === 'desktop' ? 'desktop' : 'browser';
    const session = await newSession(db, user.id, client);
    return { status: 200, value: { user: publicUser(user), expiresAt: session.expiresAt, ...(client === 'desktop' ? { token: session.token } : {}) }, headers: client === 'browser' ? { 'Set-Cookie': cookie(session.token) } : {} };
  }
  return async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if (secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    try {
      const url = new URL(req.url, origin), path = url.pathname;
      if (req.method === 'GET' && path === '/health') { await pool.query('SELECT 1'); return json(res, 200, { ok: true }); }
      const staticFiles = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] };
      if (req.method === 'GET' && staticFiles[path]) {
        const [file, type] = staticFiles[path]; res.setHeader('Content-Type', `${type}; charset=utf-8`); return res.end(await readFile(new URL(`../public/${file}`, import.meta.url)));
      }
      requireThat(path.startsWith('/api/'), 404, 'Not found.');
      // No CORS: browser UI is same-origin; desktop uses main-process HTTP with a bearer.
      if (req.headers.origin && unsafe(req.method)) requireThat(req.headers.origin === origin, 403, 'Invalid request origin.');
      const forwarded = String(req.headers['x-forwarded-for'] || '').split(',').map(s => s.trim());
      const ip = config.trustProxyHops > 0 ? forwarded.at(-config.trustProxyHops) || req.socket.remoteAddress : req.socket.remoteAddress;
      await limit(pool, `api:${ip}`, 300, 60);
      if (req.method === 'GET' && path === '/api/setup') {
        const { rows: [row] } = await pool.query('SELECT EXISTS(SELECT 1 FROM manager_users) AS initialized');
        return json(res, 200, { setupRequired: !row.initialized, setupEnabled: Boolean(config.setupToken) });
      }
      if (req.method === 'POST' && ['/api/setup','/api/auth/login','/api/auth/accept-invite'].includes(path)) {
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
        // Hash work occurs before locks; accepting existing accounts must verify their current password.
        const response = await transaction(pool, async db => {
          const { rows: [invite] } = await db.query('SELECT * FROM manager_invites WHERE token_hash=$1', [digest(input.token)]);
          requireThat(invite, 404, 'Invitation unavailable.');
          // Same lock order as company mutations, preventing accept/revoke deadlocks.
          await db.query('SELECT id FROM manager_companies WHERE id=$1 FOR UPDATE',[invite.company_id]);
          const { rows: [locked] } = await db.query('SELECT * FROM manager_invites WHERE id=$1 FOR UPDATE',[invite.id]);
          requireThat(!locked.accepted_at && !locked.revoked_at && new Date(locked.expires_at)>new Date(), 410, 'Invitation expired or already used.');
          await db.query('SELECT pg_advisory_xact_lock(hashtext($1))',[locked.email]);
          let { rows: [user] } = await db.query('SELECT * FROM manager_users WHERE email=$1 FOR UPDATE',[locked.email]);
          if (user) requireThat(await verifyPassword(input.password,user.password_hash),401,'Enter the existing account password.');
          else {
            user = { id: randomUUID(),email:locked.email,name:text(input.name,'Name') };
            const passwordHash = await hashPassword(input.password);
            await db.query('INSERT INTO manager_users(id,email,name,password_hash) VALUES($1,$2,$3,$4)',[user.id,user.email,user.name,passwordHash]);
          }
          await db.query('INSERT INTO manager_memberships(company_id,user_id,role,classification) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[locked.company_id,user.id,locked.role,locked.classification]);
          await db.query('UPDATE manager_invites SET accepted_at=now() WHERE id=$1',[locked.id]);
          await audit(db,locked.company_id,user.id,'invite.accepted',locked.id);
          return signedInResponse(req,res,db,user,input);
        });
        return json(res,response.status,response.value,response.headers);
      }
      const user = await auth(req);
      if (req.method === 'GET' && path === '/api/me') {
        const { rows } = await pool.query('SELECT c.*,m.role,m.classification FROM manager_companies c JOIN manager_memberships m ON m.company_id=c.id WHERE m.user_id=$1 ORDER BY c.name',[user.id]);
        return json(res,200,{ user:publicUser(user), companies:rows.map(publicCompany) });
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
        const passwordHash = await hashPassword(input.password);
        await transaction(pool,async db=>{
          const {rows:[current]}=await db.query('SELECT password_hash FROM manager_users WHERE id=$1 FOR UPDATE',[user.id]);
          requireThat(await verifyPassword(input.currentPassword,current.password_hash),401,'Current password is incorrect.');
          await db.query('UPDATE manager_users SET password_hash=$1 WHERE id=$2',[passwordHash,user.id]);
          await db.query('UPDATE manager_sessions SET revoked_at=now() WHERE user_id=$1',[user.id]);
        });
        return json(res,200,{ok:true,signInRequired:true},{'Set-Cookie':cookie('',0)});
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
      const match = path.match(/^\/api\/companies\/([^/]+)(\/.*)?$/);
      requireThat(match,404,'Not found.');
      const companyId=uuid(match[1]), tail=match[2]||'', input=unsafe(req.method) && req.method!=='DELETE' ? await body(req) : {};
      const result=await transaction(pool,async db=>{
        const { rows:[company] }=await db.query(`SELECT * FROM manager_companies WHERE id=$1 FOR ${unsafe(req.method)?'UPDATE':'SHARE'}`,[companyId]);
        const { rows:[member] }=await db.query('SELECT * FROM manager_memberships WHERE company_id=$1 AND user_id=$2',[companyId,user.id]);
        requireThat(company&&member,404,'Company not found.');
        const admin=()=>requireThat(isAdmin(member),403,'Administrator access required.');
        const owner=()=>requireThat(member.role==='owner',403,'Owner access required.');
        if(!tail && req.method==='GET') return {company:publicCompany({...company,...member,id:company.id})};
        if(!tail && req.method==='PATCH') {
          owner(); const name=input.name===undefined?company.name:text(input.name,'Company name');
          const visibility=input.defaultVisibility===undefined?company.default_visibility:enumValue(input.defaultVisibility,['owner','company'],'visibility');
          requireThat(input.allowCompanySharing===undefined||typeof input.allowCompanySharing==='boolean',400,'Invalid sharing policy.');
          const sharing=input.allowCompanySharing??company.allow_company_sharing;
          requireThat(sharing||visibility==='owner',400,'Default visibility must be owner when sharing is disabled.');
          await db.query('UPDATE manager_companies SET name=$1,default_visibility=$2,allow_company_sharing=$3 WHERE id=$4',[name,visibility,sharing,companyId]);
          // Turning sharing off immediately makes existing conversations private, including desktop reads.
          if(!sharing) await db.query("UPDATE manager_conversations SET visibility='owner',updated_at=now() WHERE company_id=$1 AND visibility='company'",[companyId]);
          await audit(db,companyId,user.id,'company.updated',companyId);return {ok:true};
        }
        if(tail==='/members'&&req.method==='GET') {
          const {rows}=await db.query('SELECT u.id,u.name,u.email,m.role,m.classification FROM manager_memberships m JOIN manager_users u ON u.id=m.user_id WHERE m.company_id=$1 ORDER BY u.name',[companyId]);
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
          else await db.query('UPDATE manager_memberships SET role=$1,classification=$2 WHERE company_id=$3 AND user_id=$4',[role,enumValue(input.classification??target.classification,CLASSIFICATIONS,'classification'),companyId,targetId]);
          if(['owner','admin'].includes(target.role)&&!['owner','admin'].includes(role))await db.query('UPDATE manager_invites SET revoked_at=now() WHERE company_id=$1 AND created_by=$2 AND accepted_at IS NULL AND revoked_at IS NULL',[companyId,targetId]);
          await audit(db,companyId,user.id,req.method==='DELETE'?'member.removed':'member.updated',targetId);return {ok:true};
        }
        if(tail==='/invites'&&req.method==='POST') {
          admin();const accountEmail=email(input.email),role=enumValue(input.role??'member',['admin','member','viewer'],'role'),classification=enumValue(input.classification??'general',CLASSIFICATIONS,'classification');
          if(role==='admin') owner();
          const {rowCount:privilegedInvites}=await db.query("SELECT id FROM manager_invites WHERE company_id=$1 AND email=$2 AND role='admin' AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at>now()",[companyId,accountEmail]);
          if(privilegedInvites)owner();
          const token=opaqueToken(),id=randomUUID();
          // Reissuing an invitation invalidates previous unused tokens for that address.
          await db.query('UPDATE manager_invites SET revoked_at=now() WHERE company_id=$1 AND email=$2 AND accepted_at IS NULL AND revoked_at IS NULL',[companyId,accountEmail]);
          await db.query("INSERT INTO manager_invites(id,company_id,email,role,classification,token_hash,created_by,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,now()+interval '48 hours')",[id,companyId,accountEmail,role,classification,digest(token),user.id]);
          await audit(db,companyId,user.id,'invite.created',id);return {id,token,inviteUrl:`${origin}/#invite=${token}`,expiresInHours:48};
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
          const {rows}=await db.query(`SELECT * FROM manager_conversations WHERE company_id=$1 AND (owner_id=$2 OR (visibility='company' AND $3=ANY(allowed_roles))) AND ($4::timestamptz IS NULL OR updated_at<$4) ORDER BY updated_at DESC,id DESC LIMIT 100`,[companyId,user.id,member.role,before||null]);
          return {conversations:rows.map(publicConversation)};
        }
        if(tail==='/conversations'&&req.method==='POST') {
          requireThat(member.role!=='viewer',403,'Viewers cannot create conversations.');
          const id=randomUUID(),title=text(input.title,'Title'),visibility=enumValue(input.visibility??company.default_visibility,['owner','company'],'visibility');
          requireThat(visibility!=='company'||company.allow_company_sharing,403,'Company sharing is disabled.');
          const {rows:[row]}=await db.query('INSERT INTO manager_conversations(id,company_id,owner_id,title,visibility,allowed_roles) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',[id,companyId,user.id,title,visibility,input.allowedRoles?roles(input.allowedRoles):ROLES]);
          return {conversation:publicConversation(row)};
        }
        const conv=tail.match(/^\/conversations\/([^/]+)(\/messages)?$/);
        if(conv) {
          const conversationId=uuid(conv[1]);
          const {rows:[conversation]}=await db.query('SELECT * FROM manager_conversations WHERE id=$1 AND company_id=$2',[conversationId,companyId]);
          requireThat(conversation&&canReadConversation(conversation,member,user.id),404,'Conversation not found.');
          if(!conv[2]&&req.method==='GET')return {conversation:publicConversation(conversation)};
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
