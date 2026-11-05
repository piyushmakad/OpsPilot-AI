CREATE TABLE IF NOT EXISTS agent_runs (
  id uuid PRIMARY KEY,
  request_text text NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  workflow_version integer NOT NULL DEFAULT 1,
  output_text text,
  error_text text,
  lease_token uuid,
  lease_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CHECK (char_length(request_text) BETWEEN 1 AND 10000)
);

CREATE TABLE IF NOT EXISTS agent_run_events (
  run_id uuid NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  sequence integer NOT NULL,
  kind text NOT NULL CHECK (kind IN ('decision', 'tool_result')),
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, sequence)
);

CREATE INDEX IF NOT EXISTS agent_runs_recovery_idx
  ON agent_runs (lease_expires_at)
  WHERE status = 'running';
