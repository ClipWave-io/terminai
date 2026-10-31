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
      CREATE TABLE IF NOT EXISTS manager_audit (
        id uuid PRIMARY KEY, company_id uuid REFERENCES manager_companies ON DELETE CASCADE,
        actor_id uuid REFERENCES manager_users, action text NOT NULL, target_id text,
        created_at timestamptz NOT NULL DEFAULT now()
      );
    `);
  });
}
