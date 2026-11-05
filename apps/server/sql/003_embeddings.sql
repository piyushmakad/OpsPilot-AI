ALTER TABLE knowledge_chunks
  ADD COLUMN IF NOT EXISTS embedding_model text;

CREATE INDEX IF NOT EXISTS knowledge_chunks_embedding_model_idx
  ON knowledge_chunks (embedding_model)
  WHERE embedding IS NOT NULL;
