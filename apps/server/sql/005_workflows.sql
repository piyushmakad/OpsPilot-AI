ALTER TABLE agent_runs DROP CONSTRAINT IF EXISTS agent_runs_status_check;
ALTER TABLE agent_runs ADD CONSTRAINT agent_runs_status_check CHECK (status IN
  ('pending', 'running', 'waiting_approval', 'waiting_input', 'retry_scheduled', 'waiting_external',
   'completed', 'failed', 'escalated'));
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS actor_id text;
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS scenario text;
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS next_action_at timestamptz;

ALTER TABLE agent_run_events DROP CONSTRAINT IF EXISTS agent_run_events_kind_check;
ALTER TABLE agent_run_events ADD CONSTRAINT agent_run_events_kind_check CHECK (kind IN
  ('decision', 'tool_result', 'retrieval', 'workflow_decision', 'workflow_result'));

CREATE TABLE IF NOT EXISTS demo_payments (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  actor_id text NOT NULL,
  scenario text NOT NULL,
  amount_cents integer NOT NULL CHECK (amount_cents > 0),
  currency text NOT NULL DEFAULT 'USD',
  status text NOT NULL CHECK (status IN ('SUCCEEDED', 'REFUNDED')),
  paid_at timestamptz NOT NULL,
  refund_ref text,
  fault_mode text NOT NULL DEFAULT 'none' CHECK (fault_mode IN ('none', '503_once', 'timeout_after_commit')),
  UNIQUE (tenant_id, actor_id, scenario)
);

CREATE TABLE IF NOT EXISTS workflow_operations (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES agent_runs(id),
  tenant_id text NOT NULL,
  actor_id text NOT NULL,
  payment_id uuid NOT NULL REFERENCES demo_payments(id),
  amount_cents integer NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  status text NOT NULL CHECK (status IN
    ('WAITING_APPROVAL', 'READY', 'IN_FLIGHT', 'RETRY_SCHEDULED', 'UNKNOWN', 'SUCCEEDED', 'REJECTED')),
  attempt_count integer NOT NULL DEFAULT 0,
  next_action_at timestamptz,
  external_ref text,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, payment_id)
);

CREATE TABLE IF NOT EXISTS workflow_approvals (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES agent_runs(id),
  operation_id uuid NOT NULL UNIQUE REFERENCES workflow_operations(id),
  parameters jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED')),
  decided_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  decided_at timestamptz
);

CREATE TABLE IF NOT EXISTS demo_notifications (
  id uuid PRIMARY KEY,
  operation_id uuid NOT NULL UNIQUE REFERENCES workflow_operations(id),
  tenant_id text NOT NULL,
  actor_id text NOT NULL,
  message text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agent_runs_due_idx ON agent_runs (next_action_at)
  WHERE workflow_version = 3 AND status IN ('retry_scheduled', 'waiting_external');
CREATE INDEX IF NOT EXISTS workflow_operations_due_idx ON workflow_operations (next_action_at)
  WHERE status IN ('RETRY_SCHEDULED', 'UNKNOWN', 'IN_FLIGHT');
