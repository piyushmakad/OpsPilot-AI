ALTER TABLE memory_records ADD COLUMN embedding vector(384);
ALTER TABLE memory_records ADD COLUMN embedding_model text;
CREATE INDEX memory_embedding_model_idx ON memory_records (embedding_model)
  WHERE status = 'active' AND embedding IS NOT NULL;
