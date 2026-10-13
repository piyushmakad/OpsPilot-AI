import assert from 'node:assert/strict';
import test from 'node:test';
import { WorkflowEngine } from './workflow-engine.js';
import { DemoWorkflowModel } from './workflow-model.js';
import { validateCall, type CapabilityClient, type ToolCall, type ToolObservation } from './workflow-tools.js';
import type { AgentRun, RunEvent } from './types.js';
import type { RunRepository } from './repository.js';
import type { WorkflowStore, Operation } from './workflow-store.js';

const paymentId = '11111111-1111-4111-8111-111111111111';
const now = new Date();

class MemoryWorkflow {
  run: AgentRun;
  events: RunEvent[] = [];
  operation: Operation | null = null;
  approval: 'PENDING' | 'APPROVED' | 'REJECTED' | null = null;
  notifications = 0;
  providerCalls = 0;
  readActive = 0;
  parallelSeen = false;
  policyFound = true;
  readonly amount: number;
  constructor(readonly scenario: string) {
    this.amount = scenario.startsWith('large') ? 25000 : 2500;
    this.run = { id: 'run-1', tenantId: 'demo-refunds', actorId: 'demo-customer',
      requestText: 'Refund my latest payment and WhatsApp me when it is done.',
      ragEnabled: false, status: 'pending', outputText: null, errorText: null,
      leaseToken: null, leaseExpiresAt: null, workflowVersion: 3, scenario,
      nextActionAt: null, createdAt: now, updatedAt: now };
  }
  runs(): RunRepository {
    return {
      get: async () => this.run,
      events: async () => this.events,
      append: async (_id: string, _token: string, kind: RunEvent['kind'], payload: unknown) => {
        this.events.push({ runId: this.run.id, sequence: this.events.length + 1,
          kind, payload, createdAt: new Date() });
      },
      finish: async (_id: string, _token: string, status: 'completed' | 'failed', text: string) => {
        this.run.status = status;
        if (status === 'completed') this.run.outputText = text;
        else this.run.errorText = text;
      },
      renewLease: async () => true,
    } as unknown as RunRepository;
  }
  store(): WorkflowStore {
    return {
      claim: async () => { this.run.status = 'running'; return 'lease'; },
      reconcile: async () => {
        if (this.operation?.status === 'UNKNOWN') this.operation.status = 'SUCCEEDED';
      },
      park: async (_id: string, _token: string, status: AgentRun['status'], next: Date | null) => {
        this.run.status = status;
        this.run.nextActionAt = next;
      },
      prepareRefund: async (_run: AgentRun, id: string, amount: number, threshold: number) => {
        if (id !== paymentId || amount !== this.amount) throw new Error('Invalid payment');
        if (this.scenario === 'already-refunded') return { result: 'ALREADY_REFUNDED' };
        if (!this.operation) this.operation = { id: 'op-1', runId: this.run.id, paymentId,
          amountCents: amount, idempotencyKey: 'stable-key', status: 'READY',
          attemptCount: 0, nextActionAt: null, externalRef: null };
        if (amount > threshold && !this.approval) this.approval = 'PENDING';
        if (this.approval === 'PENDING') return { result: 'WAITING_APPROVAL', operation: this.operation,
          approval: { id: 'approval-1', status: 'PENDING', expiresAt: new Date(Date.now() + 10000),
            parameters: { paymentId, amountCents: amount } } };
        if (this.approval === 'REJECTED') return { result: 'REJECTED', operation: this.operation };
        return { result: 'READY', operation: this.operation };
      },
      beginAttempt: async () => {
        if (!this.operation || !['READY', 'RETRY_SCHEDULED'].includes(this.operation.status)) return null;
        this.operation.status = 'IN_FLIGHT';
        this.operation.attemptCount++;
        return { ...this.operation };
      },
      applyMockProvider: async () => {
        this.providerCalls++;
        if (this.scenario === 'provider-503' && this.providerCalls === 1) return '503';
        if (this.scenario === 'timeout' && this.providerCalls === 1) return 'UNKNOWN';
        return 'SUCCESS';
      },
      markOperation: async (_id: string, status: string, next: Date | null) => {
        this.operation!.status = status;
        this.operation!.nextActionAt = next;
      },
      notify: async () => { this.notifications++; return 'SENT'; },
    } as unknown as WorkflowStore;
  }
  capabilities(): CapabilityClient {
    return { executeRead: async (_run: AgentRun, call: ToolCall): Promise<ToolObservation> => {
      this.readActive++;
      if (this.readActive > 1) this.parallelSeen = true;
      await new Promise(resolve => setTimeout(resolve, 2));
      this.readActive--;
      let result: unknown;
      if (call.name === 'getPayments') result = { payments: this.scenario === 'no-payment' ? [] :
        [{ id: paymentId, amountCents: this.amount,
          status: this.scenario === 'already-refunded' ? 'REFUNDED' : 'SUCCEEDED' }] };
      else if (call.name === 'getPaymentDetails') result = { payment: {
        id: paymentId, amountCents: this.amount, status: 'SUCCEEDED' } };
      else if (call.name === 'getAccount') result = { actorId: this.run.actorId, status: 'ACTIVE' };
      else result = { status: this.policyFound ? 'evidence_found' : 'insufficient_evidence' };
      return { name: call.name, result, latencyMs: 2 };
    } };
  }
  engine(): WorkflowEngine { return new WorkflowEngine(this.runs(), this.store(),
    new DemoWorkflowModel(), this.capabilities(), 10000); }
  results(name: string) { return this.events.filter(e => e.kind === 'workflow_result')
    .flatMap(e => (e.payload as { observations?: ToolObservation[] }).observations ?? [])
    .filter(o => o.name === name); }
}

test('small refund uses parallel reads, sequential writes, and sends one notification', async () => {
  const m = new MemoryWorkflow('small');
  await m.engine().execute(m.run.id);
  assert.equal(m.run.status, 'completed');
  assert.equal(m.providerCalls, 1);
  assert.equal(m.notifications, 1);
  assert.equal(m.parallelSeen, true);
  assert.equal(m.results('refundPayment').length, 1);
  assert.equal(m.results('sendWhatsApp').length, 1);
  assert.ok(m.results('refundPayment')[0]!.latencyMs >= 0);
});

test('high value refund pauses, approves, and resumes without a second logical operation', async () => {
  const m = new MemoryWorkflow('large-approve');
  await m.engine().execute(m.run.id);
  assert.equal(m.run.status, 'waiting_approval');
  assert.equal(m.providerCalls, 0);
  m.approval = 'APPROVED'; m.run.status = 'pending';
  await m.engine().execute(m.run.id);
  assert.equal(m.run.status, 'completed');
  assert.equal(m.operation?.idempotencyKey, 'stable-key');
  assert.equal(m.providerCalls, 1);
  assert.equal(m.notifications, 1);
});

test('rejected approval never reaches provider or notification', async () => {
  const m = new MemoryWorkflow('large-reject');
  await m.engine().execute(m.run.id);
  m.approval = 'REJECTED'; m.run.status = 'pending';
  await m.engine().execute(m.run.id);
  assert.equal(m.run.status, 'completed');
  assert.equal(m.providerCalls, 0);
  assert.equal(m.notifications, 0);
});

test('503 schedules a retry and reuses the same operation key', async () => {
  const m = new MemoryWorkflow('provider-503');
  await m.engine().execute(m.run.id);
  assert.equal(m.run.status, 'retry_scheduled');
  assert.equal(m.notifications, 0);
  const key = m.operation?.idempotencyKey;
  m.operation!.nextActionAt = new Date(Date.now() - 1);
  m.run.status = 'pending';
  await m.engine().execute(m.run.id);
  assert.equal(m.run.status, 'completed');
  assert.equal(m.providerCalls, 2);
  assert.equal(m.operation?.idempotencyKey, key);
  assert.equal(m.notifications, 1);
});

test('unknown refund outcome reconciles before notification and avoids another provider call', async () => {
  const m = new MemoryWorkflow('timeout');
  await m.engine().execute(m.run.id);
  assert.equal(m.run.status, 'waiting_external');
  assert.equal(m.notifications, 0);
  m.run.status = 'pending';
  await m.engine().execute(m.run.id);
  assert.equal(m.run.status, 'completed');
  assert.equal(m.providerCalls, 1);
  assert.equal(m.notifications, 1);
});

test('missing payment revises plan and makes no downstream calls', async () => {
  const m = new MemoryWorkflow('no-payment');
  await m.engine().execute(m.run.id);
  assert.equal(m.run.status, 'completed');
  assert.equal(m.events.filter(e => e.kind === 'workflow_decision' &&
    (e.payload as { kind: string }).kind === 'plan').length, 2);
  assert.equal(m.results('searchRefundPolicy').length, 0);
  assert.equal(m.providerCalls, 0);
});

test('already refunded payment avoids duplicate side effects', async () => {
  const m = new MemoryWorkflow('already-refunded');
  await m.engine().execute(m.run.id);
  assert.match(m.run.outputText!, /already refunded/);
  assert.equal(m.providerCalls, 0);
});

test('missing policy evidence blocks a proposed refund in application code', async () => {
  const m = new MemoryWorkflow('small'); m.policyFound = false;
  await assert.rejects(m.engine().execute(m.run.id), /policy evidence/);
  assert.equal(m.run.status, 'failed');
  assert.equal(m.providerCalls, 0);
});

test('tool schemas and capability routing reject unexposed or malformed calls', () => {
  assert.throws(() => validateCall({ name: 'refundPayment', args: { paymentId, amountCents: 1 } },
    ['searchRefundPolicy']), /not exposed/);
  assert.throws(() => validateCall({ name: 'refundPayment', args: { paymentId, amountCents: -1 } },
    ['refundPayment']));
});

test('the runtime stops repeated calls only after observing no progress', async () => {
  const m = new MemoryWorkflow('small');
  const stuck = { async decide() { return { kind: 'call_tools' as const,
    calls: [{ name: 'getPayments' as const, args: {} }], reasonSummary: 'Check payment again.' }; } };
  const engine = new WorkflowEngine(m.runs(), m.store(), stuck, m.capabilities(), 10000);
  await assert.rejects(engine.execute(m.run.id), /without changed observations/);
  assert.equal(m.results('getPayments').length, 2);
  assert.equal(m.providerCalls, 0);
});
