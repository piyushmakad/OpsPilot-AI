ALTER TABLE agent_runs
  ADD COLUMN IF NOT EXISTS rag_enabled boolean NOT NULL DEFAULT false;

ALTER TABLE agent_run_events
  DROP CONSTRAINT IF EXISTS agent_run_events_kind_check;

ALTER TABLE agent_run_events
  ADD CONSTRAINT agent_run_events_kind_check
  CHECK (kind IN ('decision', 'tool_result', 'retrieval'));
