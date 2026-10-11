CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE agent_runs
  ADD COLUMN IF NOT EXISTS tenant_id text NOT NULL DEFAULT 'demo';

CREATE TABLE IF NOT EXISTS knowledge_documents (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL CHECK (char_length(tenant_id) BETWEEN 1 AND 128),
  document_key text NOT NULL CHECK (char_length(document_key) BETWEEN 1 AND 128),
  version integer NOT NULL CHECK (version > 0),
  title text NOT NULL,
  source text NOT NULL,
  status text NOT NULL CHECK (status IN ('ACTIVE', 'DEPRECATED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, document_key, version)
);

CREATE TABLE IF NOT EXISTS knowledge_chunks (
  id uuid PRIMARY KEY,
  document_id uuid NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
  chunk_index integer NOT NULL CHECK (chunk_index >= 0),
  section text NOT NULL,
  content text NOT NULL CHECK (char_length(content) > 0),
  embedding vector(384),
  search_vector tsvector GENERATED ALWAYS AS (
    to_tsvector('english', section || ' ' || content)
  ) STORED,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, chunk_index)
);

CREATE INDEX IF NOT EXISTS knowledge_documents_scope_idx
  ON knowledge_documents (tenant_id, status, document_key);
CREATE INDEX IF NOT EXISTS knowledge_chunks_document_idx
  ON knowledge_chunks (document_id);
CREATE INDEX IF NOT EXISTS knowledge_chunks_search_idx
  ON knowledge_chunks USING gin (search_vector);
