ALTER TABLE agent_runs ADD COLUMN project_id text;
ALTER TABLE agent_runs ADD COLUMN conversation_id uuid REFERENCES conversations(id);
ALTER TABLE conversation_messages ADD COLUMN run_id uuid REFERENCES agent_runs(id);
CREATE UNIQUE INDEX conversation_run_response ON conversation_messages (conversation_id, run_id, role)
  WHERE run_id IS NOT NULL;
ALTER TABLE agent_run_events DROP CONSTRAINT agent_run_events_kind_check;
ALTER TABLE agent_run_events ADD CONSTRAINT agent_run_events_kind_check CHECK (kind IN
  ('decision', 'tool_result', 'retrieval', 'workflow_decision', 'workflow_result', 'context'));

CREATE TABLE conversation_summaries (
  id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES conversations(id),
  version integer NOT NULL CHECK (version > 0),
  through_sequence integer NOT NULL CHECK (through_sequence > 0),
  content jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (conversation_id, version),
  UNIQUE (conversation_id, through_sequence)
);
