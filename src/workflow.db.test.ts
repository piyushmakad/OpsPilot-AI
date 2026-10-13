import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { RunRepository } from './repository.js';
import { WorkflowStore } from './workflow-store.js';
import type { AgentRun } from './types.js';

test('PostgreSQL enforces refund ownership, approval, stable retries, and reconciliation', async () => {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for test:db');
  const runs = RunRepository.fromEnvironment();
  const store = new WorkflowStore(runs);
  const tenant = `workflow-test-${randomUUID()}`;
  const actor = `actor-${randomUUID()}`;
  const runIds: string[] = [];
  const paymentIds: string[] = [];
  async function fixture(name: string, amount: number, options: {
    owner?: string; ageDays?: number; fault?: string; status?: string,
  } = {}): Promise<{ run: AgentRun; paymentId: string }> {
    const runId = randomUUID();
    const paymentId = randomUUID();
    runIds.push(runId); paymentIds.push(paymentId);
    await runs.pool.query(`INSERT INTO agent_runs
      (id, tenant_id, actor_id, request_text, workflow_version, scenario)
      VALUES ($1, $2, $3, 'Refund latest payment', 3, $4)`, [runId, tenant, actor, name]);
    await runs.pool.query(`INSERT INTO demo_payments
      (id, tenant_id, actor_id, scenario, amount_cents, status, paid_at, fault_mode, refund_ref)
      VALUES ($1, $2, $3, $4, $5, $6, now() - ($7 * interval '1 day'), $8, $9)`,
    [paymentId, tenant, options.owner ?? actor, name, amount, options.status ?? 'SUCCEEDED',
      options.ageDays ?? 3, options.fault ?? 'none',
      options.status === 'REFUNDED' ? 'prior-refund' : null]);
    return { run: (await runs.get(runId))!, paymentId };
  }
  try {
    const unauthorized = await fixture('unauthorized', 1000, { owner: 'another-actor' });
    await assert.rejects(store.prepareRefund(unauthorized.run, unauthorized.paymentId, 1000, 10000),
      /not owned/);
    const expired = await fixture('expired', 1000, { ageDays: 45 });
    await assert.rejects(store.prepareRefund(expired.run, expired.paymentId, 1000, 10000),
      /outside the automated refund policy/);
    const wrongAmount = await fixture('wrong-amount', 1000);
    await assert.rejects(store.prepareRefund(wrongAmount.run, wrongAmount.paymentId, 900, 10000),
      /exact full USD refund/);

    const small = await fixture('small', 2500);
    const prepared = await store.prepareRefund(small.run, small.paymentId, 2500, 10000);
    assert.equal(prepared.result, 'READY');
    const op = prepared.operation!;
    const attempt = (await store.beginAttempt(op.id))!;
    assert.equal(attempt.idempotencyKey, op.idempotencyKey);
    assert.equal(await store.applyMockProvider(small.run, attempt), 'SUCCESS');
    await store.markOperation(op.id, 'SUCCEEDED', null);
    const replay = await store.prepareRefund(small.run, small.paymentId, 2500, 10000);
    assert.equal(replay.operation?.idempotencyKey, op.idempotencyKey);
    assert.equal(await store.beginAttempt(op.id), null);
    assert.equal(await store.notify(small.run, small.paymentId, 'Refund confirmed'), 'SENT');
    assert.equal(await store.notify(small.run, small.paymentId, 'Refund confirmed'), 'ALREADY_SENT');

    const large = await fixture('large', 25000);
    const approvalNeeded = await store.prepareRefund(large.run, large.paymentId, 25000, 10000);
    assert.equal(approvalNeeded.result, 'WAITING_APPROVAL');
    const approvalId = approvalNeeded.approval!.id;
    assert.equal(await store.decideApproval(approvalId, 'APPROVED', 'test-manager'), true);
    assert.equal(await store.decideApproval(approvalId, 'APPROVED', 'test-manager'), false);
    const approved = await store.prepareRefund(large.run, large.paymentId, 25000, 10000);
    assert.equal(approved.result, 'READY');
    await runs.pool.query(`UPDATE demo_payments SET status = 'REFUNDED', refund_ref = 'other-operation'
      WHERE id = $1`, [large.paymentId]);
    assert.equal((await store.prepareRefund(large.run, large.paymentId, 25000, 10000)).result,
      'ALREADY_REFUNDED');

    const retry = await fixture('retry', 3500, { fault: '503_once' });
    const retryOp = (await store.prepareRefund(retry.run, retry.paymentId, 3500, 10000)).operation!;
    assert.equal(await store.applyMockProvider(retry.run, (await store.beginAttempt(retryOp.id))!), '503');
    await store.markOperation(retryOp.id, 'RETRY_SCHEDULED', new Date(Date.now() - 1000), '503');
    const second = (await store.beginAttempt(retryOp.id))!;
    assert.equal(second.idempotencyKey, retryOp.idempotencyKey);
    assert.equal(await store.applyMockProvider(retry.run, second), 'SUCCESS');

    const timeout = await fixture('timeout', 4500, { fault: 'timeout_after_commit' });
    const timeoutOp = (await store.prepareRefund(timeout.run, timeout.paymentId, 4500, 10000)).operation!;
    assert.equal(await store.applyMockProvider(timeout.run, (await store.beginAttempt(timeoutOp.id))!), 'UNKNOWN');
    await store.markOperation(timeoutOp.id, 'UNKNOWN', new Date());
    await store.reconcile(timeout.run);
    assert.equal((await store.operation(timeoutOp.id))?.status, 'SUCCEEDED');
    assert.equal(await store.beginAttempt(timeoutOp.id), null);
  } finally {
    await runs.pool.query(`DELETE FROM demo_notifications WHERE tenant_id = $1`, [tenant]);
    await runs.pool.query(`DELETE FROM workflow_approvals WHERE run_id = ANY($1::uuid[])`, [runIds]);
    await runs.pool.query(`DELETE FROM workflow_operations WHERE tenant_id = $1`, [tenant]);
    await runs.pool.query(`DELETE FROM demo_payments WHERE tenant_id = $1`, [tenant]);
    await runs.pool.query(`DELETE FROM agent_runs WHERE id = ANY($1::uuid[])`, [runIds]);
    await runs.close();
  }
});
