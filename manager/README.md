# TerminAI Manager

A standalone Node 22 / PostgreSQL service for the TerminAI desktop client and browser company management. This directory is independently deployable; it does not build Electron. It stores accounts, revocable sessions, company memberships, tool assignments and shared conversation history. It does **not** execute agents, install tools remotely, or store Google credentials.

## Run locally

```sh
cd manager
npm ci
cp .env.example .env
# Set DATABASE_URL and a unique SETUP_TOKEN (openssl rand -hex 32).
node --env-file=.env src/server.js
```

Use PostgreSQL 14+ and Node 22+. The server creates its `manager_*` tables transactionally at startup under a migration advisory lock. Use a dedicated database. Open `http://localhost:8080`, enter the setup token and create your owner account and company. Passwords require at least 12 characters (maximum 256 bytes).

First setup is atomic and can only happen when there are no users. A private `/#setup=TOKEN` link can prefill the token; the browser immediately clears the fragment. Tokens never appear in query strings. Remove `SETUP_TOKEN` from the service after setup. There is no open registration: administrators issue single-use, 48-hour invitation links. Send links directly to intended recipients; email delivery is not part of this service. Existing accounts must supply their current password to accept an invitation.

## Railway

1. Create a separate service and PostgreSQL database. Set the service root directory to `/manager` (or upload this directory as the service root). Use `manager/railway.json` as the config path when deploying the repository, or `/railway.json` when uploading just this directory. The Docker build expects its context to be this directory.
2. Set `DATABASE_URL` to the private database reference, `PUBLIC_ORIGIN` to the exact generated HTTPS origin without trailing slash, `PORT=8080`, `TRUST_PROXY_HOPS=1`, and a random `SETUP_TOKEN` of at least 32 characters. Keep secrets in Railway variables.
3. Deploy, wait for `/health` to return `{"ok":true}`, complete browser setup, then remove `SETUP_TOKEN`. The health check verifies database connectivity. Use a PostgreSQL backup policy appropriate for conversation history.

For a different proxy topology, set `TRUST_PROXY_HOPS` to the number of trusted final proxies (0 locally). Do not blindly trust the leftmost forwarded address. TLS is terminated by Railway. `PUBLIC_ORIGIN` must be HTTPS except on loopback. PostgreSQL TLS follows the connection URL/pg configuration and is not disabled by application code.

## Access model

Roles and job classifications are separate:

| Role | Access |
| --- | --- |
| owner | Company policy, owners/admins, invitations, tool assignments and audit log |
| admin | Regular members/viewers, invitations for those roles, tool assignments and audit log |
| member | Own conversations and shared conversations allowed for the member role; can append messages |
| viewer | Read accessible conversations; cannot create/edit/append |

Classifications are `general`, `developer`, `analyst`, `marketing`. Any matching role **or** classification assignment enables a catalog item. New companies enable Chrome for all roles and Google Ads for analyst/marketing classifications. Owners/admins can remove those defaults. Role changes take effect on every request; removing a member denies all subsequent company access, including that member's private records in that company. Demoting/removing an administrator also revokes their unused invitations.

Conversations use `visibility: "owner" | "company"`. Private records remain visible only to their owner, including against company administrators. Shared records have an `allowedRoles` array; their owner always retains access while still a member. Non-viewers who can read can append messages. Only the conversation owner can change its title/visibility/allowed roles. Company owners choose a default visibility and whether sharing is allowed. Disabling sharing atomically makes **all existing** shared records private; enabling it later does not restore sharing.

Installation descriptors come exclusively from `src/catalog.js`: `chrome-devtools` launches pinned `chrome-devtools-mcp@1.9.0` with an isolated profile and usage statistics disabled; `google-ads` launches the official repository pinned to commit `0b78c0caa6d1dfbd21817487c7e571514c627c87` using pipx. No arbitrary package, shell command, argument or URL supplied by a user is executed or saved. Unassigned entries return `installation:null`; the desktop must recheck `assigned` before provisioning and use its own matching allowlist. Revoking an assignment controls future managed access; it cannot uninstall software or invalidate external Google credentials already on a desktop.

Google Ads setup requires personal Application Default Credentials scoped for Google Ads, the enabled API in the user's Cloud project, and a developer token where required. Credentials remain on that user's device. See [official Google Ads MCP setup](https://github.com/googleads/google-ads-mcp) and [Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp). The manager does not claim those credentials are connected merely because a tool is assigned.

## Desktop API

All bodies and responses are JSON. Send `Content-Type: application/json` on writes. Errors are `{error:string}` with HTTP 400/401/403/404/409/410/413/415/429/500. Company and conversation IDs are UUIDs. Cross-company/hidden records return 404. No browser CORS is enabled; call from the Electron main process, not a cross-origin renderer.

`POST /api/auth/login {email,password,client:"desktop"}` returns `{token,user:{id,email,name},expiresAt}`. Save the opaque token in the OS credential store and send `Authorization: Bearer TOKEN`. Tokens expire after seven days. Browser login omits `client` and receives an HttpOnly, SameSite=Strict, Secure HTTPS cookie, never a token in JSON. Cookie-authenticated writes require an exact matching `Origin`; desktop bearer requests can omit it. Never put bearer tokens in URLs, localStorage or logs.

| Endpoint | Result / body |
| --- | --- |
| `GET /api/setup` | `{setupRequired,setupEnabled}` |
| `POST /api/setup` | `{setupToken,email,password,name,companyName,client?}` → login response |
| `POST /api/auth/accept-invite` | `{token,name,password,client?}` → login response (invited email in `user.email`) |
| `GET /api/me` | `{user,companies:[{id,name,role,classification,defaultVisibility,allowCompanySharing}]}` |
| `POST /api/auth/logout` | Revokes current session |
| `GET /api/auth/sessions` | `{sessions:[{id,client,created_at,expires_at,current}]}` |
| `DELETE /api/auth/sessions/:id` | Revoke one of your sessions |
| `POST /api/auth/password` | `{currentPassword,password}`; revokes all sessions, sign in again |
| `POST /api/companies` | `{name}` → `{id,name}`; creates company owned by caller |

Company endpoints below are prefixed `/api/companies/:companyId`:

| Endpoint | Result / body |
| --- | --- |
| `GET /` | `{company}` |
| `PATCH /` | Owner: `{name?,defaultVisibility?,allowCompanySharing?}` |
| `GET /members` | `{members:[{id,name,email,role,classification}]}` |
| `PATCH /members/:userId` | `{role?,classification?}`; last owner cannot be removed/demoted |
| `DELETE /members/:userId` | Remove membership |
| `POST /invites` | `{email,role,classification}` → `{id,token,inviteUrl,expiresInHours}` (token shown once) |
| `GET /invites` | Recent 100 invitation statuses; no tokens |
| `DELETE /invites/:id` | Revoke invitation |
| `GET /catalog` | `{catalog:[{id,name,description,docsUrl,requirements,assigned,installation,assignments?}]}` |
| `PUT /catalog/:id/assignments` | Admin: `{roles:[],classifications:[]}` replaces assignments; unknown IDs rejected |
| `GET /conversations` | `{conversations:[{id,companyId,ownerId,title,visibility,allowedRoles,createdAt,updatedAt}]}`; most recent 100 |
| `POST /conversations` | `{title,visibility?,allowedRoles?}` → `{conversation}` |
| `GET /conversations/:id` | `{conversation}` |
| `PATCH /conversations/:id` | Owner: `{title?,visibility?,allowedRoles?}` → `{conversation}` |
| `GET /conversations/:id/messages` | Latest 200 chronological: `{messages,nextCursor,hasMore:false}` |
| `GET /conversations/:id/messages?after=UUID` | Next 200 after a message; `hasMore` indicates a full incremental page |
| `POST /conversations/:id/messages` | `{content,kind:"user"|"assistant"|"note",clientMessageId?:UUID}` → `{message,deduplicated}` |
| `GET /audit` | Admin: `{events}` (latest 100; no message content or tokens) |

Messages contain `{id,conversationId,authorId,authorName,kind,content,clientMessageId,createdAt}`. `kind:"assistant"` labels imported client content; it is not a trusted provenance claim. The authenticated writer is always stored as `authorId`. Use a stable `clientMessageId` when retrying a message: duplicate writes return the original row; reusing that ID with different content returns 409. Save `nextCursor` to poll incremental updates. Conversation-list pagination supports an ISO `before` timestamp; this initial API does not yet offer older message-history paging or full-text search.

## Security and operations

Passwords use salted scrypt (`N=32768,r=8,p=1`). Random 256-bit sessions/invitations are stored only as SHA-256 digests. PostgreSQL-backed rate limits cover API traffic, authentication attempts, password changes and company creation across replicas. Administrative mutations serialize per company, preventing concurrent last-owner removal and permission-change races. Responses disable caching; the browser UI has a restrictive CSP and creates user text with DOM text nodes. No secrets appear in audit events or error logs.

There is no email verification, password-reset mail, MFA, SSO or agent execution in this first service. Membership is invitation controlled. Account recovery currently requires an operator-assisted process; do not delete users or rewrite stored hashes as an ad hoc recovery workflow. Retention/deletion workflows and advanced audit export should be added before broad external rollout.

## Tests

```sh
npm test
# Real PostgreSQL coverage, isolated schema created/dropped automatically:
MANAGER_TEST_DATABASE_URL=postgresql://localhost/terminai_test_manager npm test
```

The integration test refuses non-loopback hosts and databases not named `terminai_test_*`. Without that variable, integration is explicitly skipped. It starts a local HTTP server, uses real transactions and checks setup replay, invitation replay, ownership invariants, tenant isolation, roles/classifications, catalog allowlisting/revocation, private/shared message access, concurrent idempotent writes, cursor precision, sharing disable, membership removal, CSRF, hashed storage, session revocation and persistent rate limiting. It never contacts an MCP, email or production service.
