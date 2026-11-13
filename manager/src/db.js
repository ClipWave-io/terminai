import pg from 'pg';
export function createPool(connectionString) {
  if (!connectionString) throw new Error('DATABASE_URL is required.');
  // pg honors sslmode in DATABASE_URL; never silently disable certificate validation.
  return new pg.Pool({ connectionString, max: 10, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000, statement_timeout: 10000 });
}
export async function transaction(pool, fn) {
  const client = await pool.connect();
  try { await client.query('BEGIN'); const result = await fn(client); await client.query('COMMIT'); return result; }
  catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
export async function migrate(pool) {
  await transaction(pool, async db => {
    await db.query("SELECT pg_advisory_xact_lock(73920811)");
    await db.query(`
      CREATE TABLE IF NOT EXISTS manager_users (
        id uuid PRIMARY KEY, email text NOT NULL UNIQUE, name text NOT NULL,
        password_hash text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS manager_companies (
        id uuid PRIMARY KEY, name text NOT NULL,
        default_visibility text NOT NULL DEFAULT 'owner' CHECK (default_visibility IN ('owner','company')),
        allow_company_sharing boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS manager_memberships (
        company_id uuid REFERENCES manager_companies ON DELETE CASCADE,
        user_id uuid REFERENCES manager_users ON DELETE CASCADE,
        role text NOT NULL CHECK (role IN ('owner','admin','member','viewer')),
        classification text NOT NULL DEFAULT 'general' CHECK (classification IN ('general','developer','analyst','marketing')),
        created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (company_id,user_id)
      );
      CREATE TABLE IF NOT EXISTS manager_sessions (
        id uuid PRIMARY KEY, token_hash text NOT NULL UNIQUE,
        user_id uuid NOT NULL REFERENCES manager_users ON DELETE CASCADE,
        client text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
        expires_at timestamptz NOT NULL, revoked_at timestamptz
      );
      CREATE INDEX IF NOT EXISTS manager_sessions_user ON manager_sessions(user_id);
      CREATE TABLE IF NOT EXISTS manager_invites (
        id uuid PRIMARY KEY, company_id uuid NOT NULL REFERENCES manager_companies ON DELETE CASCADE,
        email text NOT NULL, role text NOT NULL CHECK (role IN ('admin','member','viewer')),
        classification text NOT NULL CHECK (classification IN ('general','developer','analyst','marketing')),
        token_hash text NOT NULL UNIQUE, created_by uuid NOT NULL REFERENCES manager_users,
        expires_at timestamptz NOT NULL, accepted_at timestamptz, revoked_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS manager_catalog_assignments (
        company_id uuid NOT NULL REFERENCES manager_companies ON DELETE CASCADE,
        catalog_id text NOT NULL, subject_type text NOT NULL CHECK(subject_type IN ('role','classification')),
        subject text NOT NULL, PRIMARY KEY(company_id,catalog_id,subject_type,subject)
      );
      CREATE TABLE IF NOT EXISTS manager_conversations (
        id uuid PRIMARY KEY, company_id uuid NOT NULL REFERENCES manager_companies ON DELETE CASCADE,
        owner_id uuid NOT NULL REFERENCES manager_users,
        title text NOT NULL, visibility text NOT NULL CHECK(visibility IN ('owner','company')),
        allowed_roles text[] NOT NULL DEFAULT ARRAY['owner','admin','member','viewer'],
        created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE(id,company_id)
      );
      CREATE INDEX IF NOT EXISTS manager_conversations_company ON manager_conversations(company_id,updated_at DESC);
      CREATE TABLE IF NOT EXISTS manager_messages (
        id uuid PRIMARY KEY, conversation_id uuid NOT NULL, company_id uuid NOT NULL,
        author_id uuid NOT NULL REFERENCES manager_users,
        kind text NOT NULL CHECK(kind IN ('user','assistant','note')),
        content text NOT NULL, client_message_id uuid,
        created_at timestamptz NOT NULL DEFAULT now(),
        FOREIGN KEY(conversation_id,company_id) REFERENCES manager_conversations(id,company_id) ON DELETE CASCADE,
        UNIQUE(conversation_id,author_id,client_message_id)
      );
      CREATE INDEX IF NOT EXISTS manager_messages_conversation ON manager_messages(conversation_id,created_at,id);
      CREATE TABLE IF NOT EXISTS manager_rate_limits (
        key text PRIMARY KEY, count integer NOT NULL, resets_at timestamptz NOT NULL
      );
      CREATE TABLE IF NOT EXISTS manager_notes (
        id uuid PRIMARY KEY, company_id uuid NOT NULL REFERENCES manager_companies ON DELETE CASCADE,
        owner_id uuid NOT NULL REFERENCES manager_users ON DELETE CASCADE,
        visibility text NOT NULL CHECK(visibility IN ('private','company')),
        title text NOT NULL, body text NOT NULL DEFAULT '', status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','done')),
        assignee_id uuid REFERENCES manager_users ON DELETE SET NULL, position double precision NOT NULL DEFAULT 0,
        updated_by uuid REFERENCES manager_users ON DELETE SET NULL,
        created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS manager_notes_company ON manager_notes(company_id,visibility,owner_id);
      ALTER TABLE manager_notes ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'card' CHECK(kind IN ('card','doc'));
      ALTER TABLE manager_notes ADD COLUMN IF NOT EXISTS product text NOT NULL DEFAULT '';
      CREATE TABLE IF NOT EXISTS manager_note_files (
        id uuid PRIMARY KEY, note_id uuid NOT NULL REFERENCES manager_notes ON DELETE CASCADE,
        company_id uuid NOT NULL REFERENCES manager_companies ON DELETE CASCADE,
        name text NOT NULL, mime text NOT NULL, size integer NOT NULL, data bytea NOT NULL,
        created_by uuid REFERENCES manager_users ON DELETE SET NULL, created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS manager_note_files_note ON manager_note_files(note_id,created_at);
      CREATE TABLE IF NOT EXISTS manager_device_logins (
        id uuid PRIMARY KEY, code_hash text NOT NULL UNIQUE, poll_hash text NOT NULL UNIQUE,
        user_id uuid REFERENCES manager_users ON DELETE CASCADE, created_at timestamptz NOT NULL DEFAULT now(),
        expires_at timestamptz NOT NULL, consumed_at timestamptz
      );
      -- The TerminAI To-do's shared page, mirrored by each partner's Mac from its git repo and read and edited by the
      -- iPhone app and the website. data is the Mac's Task JSON as is; a deleted task stays as a tombstone so a Mac
      -- that still has it learns it is gone.
      CREATE TABLE IF NOT EXISTS manager_tasks (
        company_id uuid NOT NULL REFERENCES manager_companies ON DELETE CASCADE, id text NOT NULL,
        data jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
        changed_by uuid REFERENCES manager_users ON DELETE SET NULL, PRIMARY KEY (company_id,id)
      );
      -- Which account is which column of the To-do (the Mac app calls them ilai and livio).
      CREATE TABLE IF NOT EXISTS manager_task_people (
        company_id uuid NOT NULL REFERENCES manager_companies ON DELETE CASCADE, key text NOT NULL,
        user_id uuid NOT NULL REFERENCES manager_users ON DELETE CASCADE, PRIMARY KEY (company_id,key)
      );
      -- The work log: one person's day as their TerminAI wrote it (conversations, times, finished work).
      CREATE TABLE IF NOT EXISTS manager_worklogs (
        company_id uuid NOT NULL REFERENCES manager_companies ON DELETE CASCADE, person text NOT NULL, day date NOT NULL,
        data jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (company_id,person,day)
      );
      -- A conversation can be a TerminAI tab, mirrored by its Mac (source_key: the tab's key), with where and how it is now.
      ALTER TABLE manager_conversations ADD COLUMN IF NOT EXISTS source_key text;
      ALTER TABLE manager_conversations ADD COLUMN IF NOT EXISTS place text;
      ALTER TABLE manager_conversations ADD COLUMN IF NOT EXISTS tab_status text;
      ALTER TABLE manager_conversations ADD COLUMN IF NOT EXISTS seen_at timestamptz;
      CREATE UNIQUE INDEX IF NOT EXISTS manager_conversations_source ON manager_conversations(owner_id,source_key) WHERE source_key IS NOT NULL;
      -- Agent to agent: a message for a tab-conversation, typed into that tab by its owner's TerminAI when it is free.
      CREATE TABLE IF NOT EXISTS manager_agent_messages (
        id uuid PRIMARY KEY, company_id uuid NOT NULL REFERENCES manager_companies ON DELETE CASCADE,
        from_user uuid NOT NULL REFERENCES manager_users ON DELETE CASCADE, from_conversation uuid REFERENCES manager_conversations ON DELETE SET NULL,
        to_conversation uuid NOT NULL REFERENCES manager_conversations ON DELETE CASCADE, reply_to uuid REFERENCES manager_agent_messages ON DELETE CASCADE,
        content text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), delivered_at timestamptz
      );
      CREATE INDEX IF NOT EXISTS manager_agent_messages_to ON manager_agent_messages(to_conversation,delivered_at);
      -- An invitation link anyone may open until it expires (24 hours): each person who joins gives their own name and email.
      CREATE TABLE IF NOT EXISTS manager_invite_links (
        id uuid PRIMARY KEY, company_id uuid NOT NULL REFERENCES manager_companies ON DELETE CASCADE,
        token_hash text NOT NULL UNIQUE, role text NOT NULL CHECK (role IN ('admin','member','viewer')),
        created_by uuid NOT NULL REFERENCES manager_users, expires_at timestamptz NOT NULL, revoked_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      -- Bot keys: another agent (a Telegram bot, a script) acting for the person who made the key, limited to the
      -- shared sessions: list, read, message, read replies. Revocable; the token itself is never stored.
      CREATE TABLE IF NOT EXISTS manager_bot_keys (
        id uuid PRIMARY KEY, company_id uuid NOT NULL REFERENCES manager_companies ON DELETE CASCADE,
        user_id uuid NOT NULL REFERENCES manager_users ON DELETE CASCADE, name text NOT NULL, token_hash text NOT NULL UNIQUE,
        created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz, last_used_at timestamptz, revoked_at timestamptz
      );
      ALTER TABLE manager_agent_messages ADD COLUMN IF NOT EXISTS from_bot text;
      ALTER TABLE manager_sessions ADD COLUMN IF NOT EXISTS app_version text;
      -- Bot key limits: what it may do (full | reply | read), when the Mac asks before typing its message in
      -- (every | risky | none; NULL follows the person's general setting), and which conversations it may use (NULL: every Shared one).
      ALTER TABLE manager_bot_keys ADD COLUMN IF NOT EXISTS scope text NOT NULL DEFAULT 'full';
      ALTER TABLE manager_bot_keys ADD COLUMN IF NOT EXISTS approval text;
      ALTER TABLE manager_bot_keys ADD COLUMN IF NOT EXISTS conversations uuid[];
      ALTER TABLE manager_agent_messages ADD COLUMN IF NOT EXISTS from_bot_key uuid;
      -- A reply-only bot may answer into a conversation only while a question asked from it is open (30 minutes).
      CREATE TABLE IF NOT EXISTS manager_bot_asks (key_id uuid NOT NULL REFERENCES manager_bot_keys ON DELETE CASCADE, conversation_id uuid NOT NULL, until timestamptz NOT NULL, PRIMARY KEY (key_id, conversation_id));
      -- Everything a bot did: listed sessions, read one, messaged one.
      CREATE TABLE IF NOT EXISTS manager_bot_activity (id bigserial PRIMARY KEY, key_id uuid NOT NULL REFERENCES manager_bot_keys ON DELETE CASCADE, action text NOT NULL, conversation_id uuid, title text, at timestamptz NOT NULL DEFAULT now());
      CREATE INDEX IF NOT EXISTS manager_bot_activity_key ON manager_bot_activity(key_id, at DESC);
      -- Feedback from the app (Settings or the sidebar's feedback button), read by us on the operator page.
      CREATE TABLE IF NOT EXISTS manager_feedback (id uuid PRIMARY KEY, email text, message text NOT NULL, app_version text, created_at timestamptz NOT NULL DEFAULT now());
      -- Team files: one shared space, each file with who may see it (everyone, admins, or members of some products).
      CREATE TABLE IF NOT EXISTS manager_team_files (
        id uuid PRIMARY KEY, company_id uuid NOT NULL REFERENCES manager_companies ON DELETE CASCADE,
        name text NOT NULL, mime text NOT NULL, size integer NOT NULL, data bytea NOT NULL,
        access text NOT NULL DEFAULT 'all' CHECK (access IN ('all','admins','products')), products text[],
        created_by uuid REFERENCES manager_users ON DELETE SET NULL, created_at timestamptz NOT NULL DEFAULT now(), from_chat boolean NOT NULL DEFAULT false
      );
      CREATE INDEX IF NOT EXISTS manager_team_files_company ON manager_team_files(company_id,created_at DESC);
      -- Folders in team Files: a path like "Sales/Universities" ('' is the top).
      ALTER TABLE manager_team_files ADD COLUMN IF NOT EXISTS folder text NOT NULL DEFAULT '';
      -- Share links: anyone with terminai.xyz/f/<token> can open that one file until it is stopped (only the hash is kept).
      ALTER TABLE manager_team_files ADD COLUMN IF NOT EXISTS share_hash text UNIQUE;
      ALTER TABLE manager_team_files ADD COLUMN IF NOT EXISTS shared_at timestamptz;
      -- Team chat and presence (last seen, typing).
      CREATE TABLE IF NOT EXISTS manager_chat (
        id uuid PRIMARY KEY, company_id uuid NOT NULL REFERENCES manager_companies ON DELETE CASCADE,
        from_user uuid NOT NULL REFERENCES manager_users ON DELETE CASCADE, body text NOT NULL DEFAULT '',
        file_id uuid REFERENCES manager_team_files ON DELETE SET NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp()
      );
      CREATE INDEX IF NOT EXISTS manager_chat_company ON manager_chat(company_id,created_at);
      -- Calls in the chat, like WhatsApp: who called, voice or video, answered for how long, missed or declined.
      ALTER TABLE manager_chat ADD COLUMN IF NOT EXISTS call jsonb;
      CREATE TABLE IF NOT EXISTS manager_calls (
        call_id text NOT NULL, company_id uuid NOT NULL REFERENCES manager_companies ON DELETE CASCADE,
        from_user uuid NOT NULL REFERENCES manager_users ON DELETE CASCADE, video boolean NOT NULL DEFAULT false,
        created_at timestamptz NOT NULL DEFAULT now(), answered_at timestamptz, answered_by uuid, declined boolean NOT NULL DEFAULT false,
        ended_at timestamptz, PRIMARY KEY (company_id, call_id)
      );
      CREATE TABLE IF NOT EXISTS manager_presence (
        company_id uuid NOT NULL REFERENCES manager_companies ON DELETE CASCADE, user_id uuid NOT NULL REFERENCES manager_users ON DELETE CASCADE,
        seen_at timestamptz NOT NULL DEFAULT now(), typing_until timestamptz, read_at timestamptz, PRIMARY KEY (company_id,user_id)
      );
      -- Invitations can limit the newcomer to some products from the start (NULL: all of them).
      ALTER TABLE manager_invites ADD COLUMN IF NOT EXISTS products text[];
      ALTER TABLE manager_invite_links ADD COLUMN IF NOT EXISTS products text[];
      -- Chat channels: '' is the whole team; a product name is that product's chat, for its members and admins.
      ALTER TABLE manager_chat ADD COLUMN IF NOT EXISTS channel text NOT NULL DEFAULT '';
      CREATE INDEX IF NOT EXISTS manager_chat_channel ON manager_chat(company_id,channel,created_at);
      -- Calls: the offers, answers and network candidates two Macs pass each other to connect directly (kept a few minutes).
      CREATE TABLE IF NOT EXISTS manager_call_signals (
        seq bigserial PRIMARY KEY, company_id uuid NOT NULL REFERENCES manager_companies ON DELETE CASCADE,
        from_user uuid NOT NULL REFERENCES manager_users ON DELETE CASCADE, to_user uuid REFERENCES manager_users ON DELETE CASCADE,
        call_id text NOT NULL, kind text NOT NULL, data jsonb, created_at timestamptz NOT NULL DEFAULT clock_timestamp()
      );
      CREATE INDEX IF NOT EXISTS manager_call_signals_company ON manager_call_signals(company_id,seq);
      -- Permissions: a member limited to some products sees only their tasks and notes (NULL: all); who sees others' shared sessions.
      ALTER TABLE manager_memberships ADD COLUMN IF NOT EXISTS products text[];
      ALTER TABLE manager_companies ADD COLUMN IF NOT EXISTS session_visibility text NOT NULL DEFAULT 'admins';
      ALTER TABLE manager_sessions ADD COLUMN IF NOT EXISTS seen_at timestamptz;
      CREATE TABLE IF NOT EXISTS manager_audit (
        id uuid PRIMARY KEY, company_id uuid REFERENCES manager_companies ON DELETE CASCADE,
        actor_id uuid REFERENCES manager_users, action text NOT NULL, target_id text,
        created_at timestamptz NOT NULL DEFAULT now()
      );
    `);
  });
}
