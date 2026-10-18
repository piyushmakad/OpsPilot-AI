CREATE INDEX memory_active_text_search ON memory_records USING gin
  (to_tsvector('english', key || ' ' || value)) WHERE status = 'active';
