CREATE TABLE conversations (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL CHECK (length(tenant_id) BETWEEN 1 AND 128),
  user_id text NOT NULL CHECK (length(user_id) BETWEEN 1 AND 128),
  project_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE conversation_messages (
  id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES conversations(id),
  sequence integer NOT NULL CHECK (sequence > 0),
  role text NOT NULL CHECK (role IN ('user', 'assistant', 'tool', 'system')),
  content text NOT NULL CHECK (length(content) BETWEEN 1 AND 20000),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (conversation_id, sequence)
);

CREATE TABLE memory_records (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL CHECK (length(tenant_id) BETWEEN 1 AND 128),
  user_id text NOT NULL CHECK (length(user_id) BETWEEN 1 AND 128),
  type text NOT NULL CHECK (type IN ('semantic', 'episodic', 'procedural', 'project_decision', 'user_preference')),
  scope_type text NOT NULL CHECK (scope_type IN ('global', 'project', 'conversation')),
  scope_id text NOT NULL DEFAULT '',
  key text NOT NULL CHECK (length(key) BETWEEN 1 AND 128),
  value text NOT NULL CHECK (length(value) BETWEEN 1 AND 4000),
  value_fingerprint char(64) NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'superseded', 'archived')),
  version integer NOT NULL CHECK (version > 0),
  supersedes_id uuid REFERENCES memory_records(id),
  importance numeric(3,2) NOT NULL CHECK (importance BETWEEN 0 AND 1),
  confidence numeric(3,2) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  source_type text NOT NULL CHECK (source_type IN ('user_message', 'tool_result', 'system', 'model_inference')),
  source_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  CHECK ((scope_type = 'global' AND scope_id = '') OR
    (scope_type <> 'global' AND length(scope_id) BETWEEN 1 AND 128)),
  UNIQUE (tenant_id, user_id, scope_type, scope_id, key, version)
);

CREATE UNIQUE INDEX memory_one_active_key ON memory_records
  (tenant_id, user_id, scope_type, scope_id, key) WHERE status = 'active';
CREATE INDEX memory_active_scope ON memory_records
  (tenant_id, user_id, scope_type, scope_id) WHERE status = 'active';
CREATE INDEX conversations_owner ON conversations (tenant_id, user_id, created_at);
