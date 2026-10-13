import { randomUUID } from 'node:crypto';
import type { AgentRun } from './types.js';
import { RunRepository } from './repository.js';

export const DEMO_TENANT = 'demo-refunds';
export const DEMO_ACTOR = 'demo-customer';
export const SCENARIOS = ['small', 'large-approve', 'large-reject', 'already-refunded',
  'provider-503', 'timeout', 'no-payment'] as const;
export type Scenario = typeof SCENARIOS[number];

type Row = Record<string, unknown>;
export type Payment = {
  id: string; amountCents: number; currency: string; status: 'SUCCEEDED' | 'REFUNDED';
  paidAt: Date; refundRef: string | null; faultMode: string;
};
export type Operation = {
  id: string; runId: string; paymentId: string; amountCents: number; idempotencyKey: string;
  status: string; attemptCount: number; nextActionAt: Date | null; externalRef: string | null;
};
export type Approval = { id: string; status: string; expiresAt: Date; parameters: { paymentId: string; amountCents: number } };

function payment(row: Row): Payment {
  return { id: String(row.id), amountCents: Number(row.amount_cents), currency: String(row.currency),
    status: row.status as Payment['status'], paidAt: row.paid_at as Date,
    refundRef: row.refund_ref as string | null, faultMode: String(row.fault_mode) };
}
function operation(row: Row): Operation {
  return { id: String(row.id), runId: String(row.run_id), paymentId: String(row.payment_id),
    amountCents: Number(row.amount_cents), idempotencyKey: String(row.idempotency_key),
    status: String(row.status), attemptCount: Number(row.attempt_count),
    nextActionAt: row.next_action_at as Date | null, externalRef: row.external_ref as string | null };
}

export class WorkflowStore {
  constructor(readonly runs: RunRepository) {}
  get db() { return this.runs.pool; }

  async create(goal: string, scenario: Scenario): Promise<AgentRun> {
    const text = goal.trim();
    if (!text || text.length > 10000 || !SCENARIOS.includes(scenario)) throw new Error('Invalid goal or scenario');
    const id = randomUUID();
    await this.db.query(`INSERT INTO agent_runs
      (id, tenant_id, actor_id, request_text, workflow_version, scenario)
      VALUES ($1, $2, $3, $4, 3, $5)`, [id, DEMO_TENANT, DEMO_ACTOR, text, scenario]);
    return (await this.runs.get(id))!;
  }

  async claim(id: string): Promise<string | null> {
    const token = randomUUID();
    const result = await this.db.query(`UPDATE agent_runs SET status = 'running', lease_token = $2,
      lease_expires_at = now() + interval '2 minutes', next_action_at = NULL, updated_at = now()
      WHERE id = $1 AND workflow_version = 3 AND
        (status = 'pending' OR (status = 'running' AND lease_expires_at < now()) OR
         (status IN ('retry_scheduled', 'waiting_external') AND next_action_at <= now()))
      RETURNING id`, [id, token]);
    return result.rowCount ? token : null;
  }

  async park(id: string, token: string, status: 'waiting_approval' | 'waiting_input' | 'retry_scheduled' |
    'waiting_external' | 'escalated', next: Date | null = null): Promise<void> {
    const result = await this.db.query(`UPDATE agent_runs SET status = $3, next_action_at = $4,
      lease_token = NULL, lease_expires_at = NULL, updated_at = now()
      WHERE id = $1 AND status = 'running' AND lease_token = $2 AND lease_expires_at > now()`,
    [id, token, status, next]);
    if (!result.rowCount) throw new Error('Run lease lost');
  }

  async dueRuns(limit = 20): Promise<string[]> {
    const result = await this.db.query(`SELECT id FROM agent_runs WHERE workflow_version = 3 AND
      (status = 'pending' OR (status = 'running' AND lease_expires_at < now()) OR
       (status IN ('retry_scheduled', 'waiting_external') AND next_action_at <= now()))
      ORDER BY created_at LIMIT $1`, [limit]);
    return result.rows.map(row => String(row.id));
  }

  async seed(): Promise<void> {
    const rows: Array<[Scenario, number, string, string]> = [
      ['small', 2500, 'SUCCEEDED', 'none'],
      ['large-approve', 25000, 'SUCCEEDED', 'none'],
      ['large-reject', 26000, 'SUCCEEDED', 'none'],
      ['already-refunded', 3000, 'REFUNDED', 'none'],
      ['provider-503', 3500, 'SUCCEEDED', '503_once'],
      ['timeout', 4500, 'SUCCEEDED', 'timeout_after_commit'],
    ];
    for (const [scenario, amount, status, fault] of rows) {
      await this.db.query(`INSERT INTO demo_payments
        (id, tenant_id, actor_id, scenario, amount_cents, status, paid_at, fault_mode, refund_ref)
        VALUES ($1, $2, $3, $4, $5, $6, now() - interval '3 days', $7, $8)
        ON CONFLICT (tenant_id, actor_id, scenario) DO NOTHING`,
      [randomUUID(), DEMO_TENANT, DEMO_ACTOR, scenario, amount, status, fault,
        status === 'REFUNDED' ? 'prior-refund' : null]);
    }
  }

  async resetDemo(): Promise<void> {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      const runs = await client.query(`SELECT id, status FROM agent_runs
        WHERE tenant_id = $1 AND workflow_version = 3 FOR UPDATE`, [DEMO_TENANT]);
      if (runs.rows.some(row => row.status === 'running')) {
        throw new Error('Stop the Day 3 worker before resetting demo runs');
      }
      const ids = runs.rows.map(row => String(row.id));
      await client.query(`DELETE FROM demo_notifications WHERE tenant_id = $1`, [DEMO_TENANT]);
      await client.query(`DELETE FROM workflow_approvals WHERE run_id = ANY($1::uuid[])`, [ids]);
      await client.query(`DELETE FROM workflow_operations WHERE tenant_id = $1`, [DEMO_TENANT]);
      await client.query(`DELETE FROM agent_run_events WHERE run_id = ANY($1::uuid[])`, [ids]);
      await client.query(`DELETE FROM agent_runs WHERE id = ANY($1::uuid[])`, [ids]);
      await client.query(`DELETE FROM demo_payments WHERE tenant_id = $1 AND actor_id = $2`,
        [DEMO_TENANT, DEMO_ACTOR]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }

  async payments(run: AgentRun): Promise<Payment[]> {
    const result = await this.db.query(`SELECT * FROM demo_payments
      WHERE tenant_id = $1 AND actor_id = $2 AND scenario = $3 ORDER BY paid_at DESC`,
    [run.tenantId, run.actorId, run.scenario]);
    return result.rows.map(payment);
  }

  async payment(run: AgentRun, id: string): Promise<Payment | null> {
    const result = await this.db.query(`SELECT * FROM demo_payments WHERE id = $1
      AND tenant_id = $2 AND actor_id = $3 AND scenario = $4`,
    [id, run.tenantId, run.actorId, run.scenario]);
    return result.rows[0] ? payment(result.rows[0]) : null;
  }

  async prepareRefund(run: AgentRun, paymentId: string, amountCents: number,
    thresholdCents: number): Promise<{ result: 'READY' | 'WAITING_APPROVAL' | 'REJECTED' |
      'ALREADY_REFUNDED' | 'BUSY'; operation?: Operation; approval?: Approval }> {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      const found = await client.query(`SELECT * FROM demo_payments WHERE id = $1
        AND tenant_id = $2 AND actor_id = $3 AND scenario = $4 FOR UPDATE`,
      [paymentId, run.tenantId, run.actorId, run.scenario]);
      if (!found.rows[0]) throw new Error('Payment not found or not owned by requester');
      const p = payment(found.rows[0]);
      if (!Number.isSafeInteger(amountCents) || amountCents !== p.amountCents || p.currency !== 'USD') {
        throw new Error('Only an exact full USD refund is allowed');
      }
      const prior = await client.query('SELECT * FROM workflow_operations WHERE tenant_id = $1 AND payment_id = $2 FOR UPDATE',
        [run.tenantId, paymentId]);
      let op = prior.rows[0] ? operation(prior.rows[0]) : null;
      if (op && (op.runId !== run.id || op.amountCents !== amountCents)) {
        await client.query('COMMIT');
        return { result: op.status === 'SUCCEEDED' || p.status === 'REFUNDED' ? 'ALREADY_REFUNDED' : 'BUSY' };
      }
      if (!op && p.status === 'REFUNDED') {
        await client.query('COMMIT');
        return { result: 'ALREADY_REFUNDED' };
      }
      if (!op && (p.status !== 'SUCCEEDED' || Date.now() - p.paidAt.getTime() > 30 * 86400000 ||
        p.paidAt.getTime() > Date.now())) throw new Error('Payment is outside the automated refund policy');
      if (op && op.status !== 'SUCCEEDED' && p.status === 'SUCCEEDED' &&
        (Date.now() - p.paidAt.getTime() > 30 * 86400000 || p.paidAt.getTime() > Date.now())) {
        throw new Error('Refund eligibility changed while the run was paused');
      }
      if (!op) {
        const id = randomUUID();
        const key = `refund:${run.tenantId}:${p.id}:full`;
        const status = amountCents > thresholdCents ? 'WAITING_APPROVAL' : 'READY';
        const inserted = await client.query(`INSERT INTO workflow_operations
          (id, run_id, tenant_id, actor_id, payment_id, amount_cents, idempotency_key, status)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [id, run.id, run.tenantId, run.actorId, p.id, amountCents, key, status]);
        op = operation(inserted.rows[0]);
        if (status === 'WAITING_APPROVAL') {
          await client.query(`INSERT INTO workflow_approvals
            (id, run_id, operation_id, parameters, status, expires_at)
            VALUES ($1, $2, $3, $4::jsonb, 'PENDING', now() + interval '24 hours')`,
          [randomUUID(), run.id, id, JSON.stringify({ paymentId, amountCents })]);
        }
      }
      const approvalRow = await client.query('SELECT * FROM workflow_approvals WHERE operation_id = $1', [op.id]);
      if (!approvalRow.rows[0] && amountCents > thresholdCents && op.status !== 'SUCCEEDED') {
        await client.query(`UPDATE workflow_operations SET status = 'WAITING_APPROVAL',
          updated_at = now() WHERE id = $1`, [op.id]);
        const added = await client.query(`INSERT INTO workflow_approvals
          (id, run_id, operation_id, parameters, status, expires_at)
          VALUES ($1, $2, $3, $4::jsonb, 'PENDING', now() + interval '24 hours') RETURNING *`,
        [randomUUID(), run.id, op.id, JSON.stringify({ paymentId, amountCents })]);
        approvalRow.rows.push(added.rows[0]);
        op.status = 'WAITING_APPROVAL';
      }
      const a = approvalRow.rows[0];
      const approval = a ? { id: String(a.id), status: String(a.status),
        expiresAt: a.expires_at as Date, parameters: a.parameters as Approval['parameters'] } : undefined;
      if (approval && (approval.parameters.paymentId !== paymentId ||
        approval.parameters.amountCents !== amountCents)) throw new Error('Approval parameters do not match refund');
      if (approval && approval.status === 'REJECTED') {
        await client.query('COMMIT');
        return { result: 'REJECTED', operation: op, approval };
      }
      if (approval && (approval.status !== 'APPROVED' || approval.expiresAt.getTime() <= Date.now())) {
        await client.query('COMMIT');
        return { result: 'WAITING_APPROVAL', operation: op, approval };
      }
      if (p.status === 'REFUNDED' && p.refundRef !== op.idempotencyKey) {
        await client.query('COMMIT');
        return { result: 'ALREADY_REFUNDED' };
      }
      if (op.status === 'SUCCEEDED' &&
        (p.status !== 'REFUNDED' || p.refundRef !== op.idempotencyKey)) {
        throw new Error('Refund operation and payment state disagree');
      }
      if (op.status === 'WAITING_APPROVAL') {
        const ready = await client.query(`UPDATE workflow_operations SET status = 'READY', updated_at = now()
          WHERE id = $1 RETURNING *`, [op.id]);
        op = operation(ready.rows[0]);
      }
      await client.query('COMMIT');
      return { result: 'READY', operation: op, approval };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  async decideApproval(id: string, decision: 'APPROVED' | 'REJECTED', managerId: string): Promise<boolean> {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      const updated = await client.query(`UPDATE workflow_approvals SET status = $2, decided_by = $3,
        decided_at = now() WHERE id = $1 AND status = 'PENDING' AND expires_at > now()
        RETURNING run_id, operation_id`, [id, decision, managerId]);
      if (!updated.rows[0]) { await client.query('ROLLBACK'); return false; }
      if (decision === 'REJECTED') await client.query(`UPDATE workflow_operations SET status = 'REJECTED'
        WHERE id = $1`, [updated.rows[0].operation_id]);
      await client.query(`UPDATE agent_runs SET status = 'pending', next_action_at = NULL,
        updated_at = now() WHERE id = $1 AND status = 'waiting_approval'`, [updated.rows[0].run_id]);
      await client.query('COMMIT');
      return true;
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }

  async approval(id: string): Promise<Row | null> {
    const result = await this.db.query('SELECT * FROM workflow_approvals WHERE id = $1', [id]);
    return result.rows[0] ?? null;
  }
  async reply(id: string, actorId: string, answer: string): Promise<boolean> {
    const text = answer.trim();
    if (!text || text.length > 2000) throw new Error('Reply must contain 1 to 2,000 characters');
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      const run = await client.query(`SELECT id FROM agent_runs WHERE id = $1 AND actor_id = $2
        AND workflow_version = 3 AND status = 'waiting_input' FOR UPDATE`, [id, actorId]);
      if (!run.rowCount) { await client.query('ROLLBACK'); return false; }
      await client.query(`INSERT INTO agent_run_events (run_id, sequence, kind, payload)
        SELECT $1, COALESCE(MAX(sequence), 0) + 1, 'workflow_result', $2::jsonb
        FROM agent_run_events WHERE run_id = $1`, [id, JSON.stringify({ type: 'user_reply', text, observations: [] })]);
      await client.query(`UPDATE agent_runs SET status = 'pending', updated_at = now() WHERE id = $1`, [id]);
      await client.query('COMMIT');
      return true;
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  async approvals(): Promise<Row[]> {
    const result = await this.db.query(`SELECT a.*, r.request_text FROM workflow_approvals a
      JOIN agent_runs r ON r.id = a.run_id WHERE a.status = 'PENDING' ORDER BY a.created_at DESC`);
    return result.rows;
  }

  async expireApprovals(): Promise<number> {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      const expired = await client.query(`UPDATE workflow_approvals SET status = 'EXPIRED',
        decided_at = now() WHERE status = 'PENDING' AND expires_at <= now()
        RETURNING run_id, operation_id`);
      for (const row of expired.rows) {
        await client.query(`UPDATE workflow_operations SET status = 'REJECTED', updated_at = now()
          WHERE id = $1 AND status = 'WAITING_APPROVAL'`, [row.operation_id]);
        await client.query(`UPDATE agent_runs SET status = 'escalated', updated_at = now()
          WHERE id = $1 AND status = 'waiting_approval'`, [row.run_id]);
      }
      await client.query('COMMIT');
      return expired.rowCount ?? 0;
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }

  async inspector(id: string): Promise<{ operation: Row | null; approval: Row | null; notification: Row | null }> {
    const [operationRows, approvalRows, notificationRows] = await Promise.all([
      this.db.query('SELECT * FROM workflow_operations WHERE run_id = $1', [id]),
      this.db.query('SELECT * FROM workflow_approvals WHERE run_id = $1', [id]),
      this.db.query(`SELECT n.* FROM demo_notifications n JOIN workflow_operations o
        ON o.id = n.operation_id WHERE o.run_id = $1`, [id]),
    ]);
    return { operation: operationRows.rows[0] ?? null, approval: approvalRows.rows[0] ?? null,
      notification: notificationRows.rows[0] ?? null };
  }

  async beginAttempt(id: string): Promise<Operation | null> {
    const result = await this.db.query(`UPDATE workflow_operations SET status = 'IN_FLIGHT',
      attempt_count = attempt_count + 1, next_action_at = NULL, updated_at = now()
      WHERE id = $1 AND (status = 'READY' OR
        (status = 'RETRY_SCHEDULED' AND next_action_at <= now())) RETURNING *`, [id]);
    return result.rows[0] ? operation(result.rows[0]) : null;
  }

  async applyMockProvider(run: AgentRun, op: Operation): Promise<'SUCCESS' | '503' | 'UNKNOWN'> {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      const found = await client.query(`SELECT * FROM demo_payments WHERE id = $1
        AND tenant_id = $2 AND actor_id = $3 FOR UPDATE`, [op.paymentId, run.tenantId, run.actorId]);
      if (!found.rows[0]) throw new Error('Payment disappeared');
      const p = payment(found.rows[0]);
      if (p.amountCents !== op.amountCents || p.currency !== 'USD' ||
        p.paidAt.getTime() > Date.now() || Date.now() - p.paidAt.getTime() > 30 * 86400000) {
        throw new Error('Refund invariant changed before provider execution');
      }
      if (p.status === 'REFUNDED') {
        if (p.refundRef !== op.idempotencyKey) throw new Error('Payment refunded by a different operation');
        await client.query('COMMIT');
        return 'SUCCESS';
      }
      if (p.faultMode === '503_once' && op.attemptCount === 1) {
        await client.query('COMMIT');
        return '503';
      }
      await client.query(`UPDATE demo_payments SET status = 'REFUNDED', refund_ref = $2 WHERE id = $1`,
        [p.id, op.idempotencyKey]);
      await client.query('COMMIT');
      return p.faultMode === 'timeout_after_commit' && op.attemptCount === 1 ? 'UNKNOWN' : 'SUCCESS';
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }

  async markOperation(id: string, status: 'SUCCEEDED' | 'RETRY_SCHEDULED' | 'UNKNOWN',
    next: Date | null, error: string | null = null): Promise<void> {
    await this.db.query(`UPDATE workflow_operations SET status = $2, next_action_at = $3,
      last_error = $4, external_ref = CASE WHEN $2 = 'SUCCEEDED' THEN idempotency_key ELSE external_ref END,
      updated_at = now() WHERE id = $1`, [id, status, next, error]);
  }

  async reconcile(run: AgentRun): Promise<void> {
    const result = await this.db.query(`SELECT o.*, p.status AS payment_status, p.refund_ref
      FROM workflow_operations o JOIN demo_payments p ON p.id = o.payment_id
      WHERE o.run_id = $1 AND o.status IN ('UNKNOWN', 'IN_FLIGHT')`, [run.id]);
    for (const row of result.rows) {
      const op = operation(row);
      if (row.payment_status === 'REFUNDED' && row.refund_ref === op.idempotencyKey) {
        await this.markOperation(op.id, 'SUCCEEDED', null);
      } else if (row.payment_status === 'REFUNDED') {
        throw new Error('Payment was refunded by another operation during reconciliation');
      } else if (op.status === 'UNKNOWN' ||
        (op.status === 'IN_FLIGHT' && Date.now() - (row.updated_at as Date).getTime() > 120000)) {
        await this.db.query(`UPDATE workflow_operations SET status = 'READY',
          next_action_at = NULL, updated_at = now() WHERE id = $1`, [op.id]);
      }
    }
  }

  async operation(id: string): Promise<Operation | null> {
    const result = await this.db.query('SELECT * FROM workflow_operations WHERE id = $1', [id]);
    return result.rows[0] ? operation(result.rows[0]) : null;
  }

  async notify(run: AgentRun, paymentId: string, message: string): Promise<'SENT' | 'ALREADY_SENT'> {
    const found = await this.db.query(`SELECT o.* FROM workflow_operations o
      WHERE o.payment_id = $1 AND o.tenant_id = $2 AND o.actor_id = $3 AND o.run_id = $4
        AND o.status = 'SUCCEEDED'`, [paymentId, run.tenantId, run.actorId, run.id]);
    if (!found.rows[0]) throw new Error('Trusted refund success required before notification');
    const op = operation(found.rows[0]);
    const inserted = await this.db.query(`INSERT INTO demo_notifications
      (id, operation_id, tenant_id, actor_id, message) VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (operation_id) DO NOTHING RETURNING id`,
    [randomUUID(), op.id, run.tenantId, run.actorId, message]);
    return inserted.rowCount ? 'SENT' : 'ALREADY_SENT';
  }
}
