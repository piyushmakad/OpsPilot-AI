ALTER TABLE agent_runs ADD COLUMN request_message_id uuid REFERENCES conversation_messages(id) ON DELETE SET NULL;
ALTER TABLE agent_runs ADD CONSTRAINT run_request_needs_conversation
  CHECK (request_message_id IS NULL OR conversation_id IS NOT NULL);
