import type { AgentRun, RunEvent } from './types.js';
import { createHash } from 'node:crypto';
import { RunRepository } from './repository.js';
import { WorkflowStore } from './workflow-store.js';
import { exposedTools, toolDefinitions, validateCall,
  type CapabilityClient, type ToolCall, type ToolObservation } from './workflow-tools.js';
import type { WorkflowDecision, WorkflowModel } from './workflow-model.js';
import { MockRefundProvider, type RefundProvider } from './workflow-provider.js';

const MAX_DECISIONS = 20;
const MAX_CALLS = 30;
const MAX_ACTIVE_MS = 100000;
const MAX_RETRIES = 3;

type Outcome = 'completed' | 'paused' | 'unclaimed';

export class WorkflowEngine {
  constructor(private readonly runs: RunRepository, private readonly store: WorkflowStore,
    private readonly model: WorkflowModel, private readonly capabilities: CapabilityClient,
    private readonly thresholdCents = Number(process.env.AUTO_REFUND_MAX_CENTS ?? 10000),
    private readonly provider: RefundProvider = new MockRefundProvider(store)) {
    if (!Number.isSafeInteger(thresholdCents) || thresholdCents < 0) {
      throw new Error('AUTO_REFUND_MAX_CENTS must be a nonnegative integer');
    }
  }

  async execute(id: string): Promise<Outcome> {
    const token = await this.store.claim(id);
    if (!token) return 'unclaimed';
    const started = Date.now();
    const heartbeat = setInterval(() => {
      void this.runs.renewLease(id, token).catch(error =>
        console.error('Run lease heartbeat failed:', id, error));
    }, 20000);
    try {
      const initial = await this.runs.get(id);
      if (!initial || initial.workflowVersion !== 3) throw new Error('Day 3 run not found');
      await this.provider.reconcile(initial);
      for (;;) {
        if (Date.now() - started > MAX_ACTIVE_MS) throw new Error('Active execution time limit reached');
        const run = (await this.runs.get(id))!;
        const events = await this.runs.events(id);
        const decisions = events.filter(e => e.kind === 'workflow_decision');
        const priorCalls = decisions.flatMap(e => {
          const d = e.payload as WorkflowDecision;
          return d.kind === 'call_tools' ? d.calls : [];
        });
        const latest = events.at(-1);
        if (latest?.kind === 'workflow_decision') {
          const decision = latest.payload as WorkflowDecision;
          if (decision.kind === 'final') {
            const observations = events.filter(e => e.kind === 'workflow_result')
              .flatMap(e => (e.payload as { observations?: ToolObservation[] }).observations ?? []);
            const refunded = observations.some(o => o.name === 'refundPayment' &&
              (o.result as { status?: string }).status === 'REFUND_SUCCEEDED');
            const alreadyRefunded = observations.some(o => o.name === 'refundPayment' &&
              (o.result as { status?: string }).status === 'ALREADY_REFUNDED') ||
              observations.some(o => o.name === 'getPayments' &&
                ((o.result as { payments?: Array<{ status: string }> }).payments ?? [])
                  .some(p => p.status === 'REFUNDED'));
            const notified = observations.some(o => o.name === 'sendWhatsApp' &&
              ['SENT', 'ALREADY_SENT'].includes((o.result as { status?: string }).status ?? ''));
            if (!refunded && !alreadyRefunded && /\b(refunded|refund completed|refund succeeded)\b/i.test(decision.text)) {
              throw new Error('Final answer claims a refund without trusted success');
            }
            if (!notified && /\b(whatsapp confirmation sent|whatsapp sent)\b/i.test(decision.text)) {
              throw new Error('Final answer claims a notification without trusted success');
            }
            await this.runs.finish(id, token, 'completed', decision.text);
            return 'completed';
          }
          if (decision.kind === 'clarify') {
            await this.store.park(id, token, 'waiting_input');
            return 'paused';
          }
          if (decision.kind === 'escalate') {
            await this.store.park(id, token, 'escalated');
            return 'paused';
          }
          if (decision.kind === 'plan') {
            const version = decisions.filter(e => (e.payload as WorkflowDecision).kind === 'plan').length;
            await this.runs.append(id, token, 'workflow_result', {
              type: 'plan_recorded', version, steps: decision.steps, observations: [],
            });
            continue;
          }
          const result = await this.executeCalls(run, token, decision.calls, events);
          if (result === 'paused') return 'paused';
          continue;
        }
        if (decisions.length >= MAX_DECISIONS || priorCalls.length >= MAX_CALLS) {
          await this.runs.finish(id, token, 'failed', 'Agent decision or tool-call limit reached');
          return 'completed';
        }
        const decision = await this.model.decide(run.requestText, events, exposedTools(run.requestText));
        this.validateDecision(decision, run, events);
        await this.runs.append(id, token, 'workflow_decision', decision);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      try { await this.runs.finish(id, token, 'failed', message); } catch { /* lease moved */ }
      throw error;
    } finally {
      clearInterval(heartbeat);
    }
  }

  private validateDecision(decision: WorkflowDecision, run: AgentRun, events: RunEvent[]): void {
    if (decision.kind === 'plan') {
      if (!decision.steps.length || decision.steps.length > 12) throw new Error('Invalid plan');
      return;
    }
    if (decision.kind !== 'call_tools') return;
    if (!decision.calls.length || decision.calls.length > 4) throw new Error('Invalid tool batch size');
    const exposed = exposedTools(run.requestText);
    const calls = decision.calls.map(call => validateCall(call, exposed));
    const writes = calls.filter(call => toolDefinitions[call.name].risk !== 'read');
    if (writes.length && calls.length !== 1) throw new Error('Side effects must execute alone');
    const used = events.filter(e => e.kind === 'workflow_decision').flatMap(e => {
      const prior = e.payload as WorkflowDecision;
      return prior.kind === 'call_tools' ? prior.calls : [];
    }).length;
    if (used + calls.length > MAX_CALLS) throw new Error('Agent tool-call limit reached');
    const keys = calls.map(call => JSON.stringify(call));
    if (new Set(keys).size !== keys.length) throw new Error('Duplicate call in a batch');
  }

  private async recordObservations(runId: string, token: string, calls: ToolCall[],
    observations: ToolObservation[], events: RunEvent[]): Promise<void> {
    const signature = createHash('sha256').update(JSON.stringify({
      calls, results: observations.map(o => o.result),
    })).digest('hex');
    const unchanged = events.filter(e => e.kind === 'workflow_result' &&
      (e.payload as { progressSignature?: string }).progressSignature === signature).length;
    if (unchanged >= 2) throw new Error('Agent repeated an action twice without changed observations');
    await this.runs.append(runId, token, 'workflow_result', {
      type: 'tool_batch', execution: observations.length > 1 ? 'parallel' : 'sequential',
      progressSignature: signature, observations,
    });
  }

  private async executeCalls(run: AgentRun, token: string, calls: ToolCall[], events: RunEvent[]): Promise<'done' | 'paused'> {
    const validated = calls.map(call => validateCall(call, exposedTools(run.requestText)));
    if (validated.every(call => toolDefinitions[call.name].risk === 'read')) {
      const observations = await Promise.all(validated.map(call => this.capabilities.executeRead(run, call)));
      await this.recordObservations(run.id, token, validated, observations, events);
      return 'done';
    }
    const call = validated[0]!;
    const start = performance.now();
    if (call.name === 'refundPayment') {
      const outcome = await this.refund(run, token, call, events);
      if (outcome.kind === 'park') return 'paused';
      await this.recordObservations(run.id, token, validated, [{ name: call.name,
        result: outcome.result, latencyMs: Math.round(performance.now() - start) }], events);
      return 'done';
    }
    if (call.name === 'sendWhatsApp') {
      const result = await this.store.notify(run, String(call.args.paymentId),
        `Your payment ${String(call.args.paymentId)} was refunded.`);
      await this.recordObservations(run.id, token, validated, [{ name: call.name,
        result: { status: result }, latencyMs: Math.round(performance.now() - start) }], events);
      return 'done';
    }
    throw new Error('Unsupported write tool');
  }

  private async refund(run: AgentRun, token: string, call: ToolCall, events: RunEvent[]): Promise<
    { kind: 'result'; result: { status: string; operationId?: string; idempotencyKey?: string } } |
    { kind: 'park' }> {
    const paymentId = String(call.args.paymentId);
    const amount = Number(call.args.amountCents);
    const observations = events.filter(e => e.kind === 'workflow_result')
      .flatMap(e => (e.payload as { observations?: ToolObservation[] }).observations ?? []);
    const details = [...observations].reverse().find(o => o.name === 'getPaymentDetails')?.result as
      { payment?: { id: string; amountCents: number; status: string } } | undefined;
    const policy = [...observations].reverse().find(o => o.name === 'searchRefundPolicy')?.result as
      { status?: string } | undefined;
    const account = [...observations].reverse().find(o => o.name === 'getAccount')?.result as
      { actorId?: string; status?: string } | undefined;
    if (details?.payment?.id !== paymentId || details.payment.amountCents !== amount ||
      details.payment.status !== 'SUCCEEDED' || policy?.status !== 'evidence_found' ||
      account?.actorId !== run.actorId || account.status !== 'ACTIVE') {
      throw new Error('Refund requires matching payment, account, and policy evidence');
    }
    const prepared = await this.store.prepareRefund(run, paymentId, amount, this.thresholdCents);
    if (prepared.result === 'ALREADY_REFUNDED' || prepared.result === 'REJECTED') {
      return { kind: 'result', result: { status: prepared.result } };
    }
    if (prepared.result === 'BUSY') {
      await this.store.park(run.id, token, 'escalated');
      return { kind: 'park' };
    }
    if (prepared.result === 'WAITING_APPROVAL') {
      if (prepared.approval && prepared.approval.expiresAt.getTime() <= Date.now()) {
        await this.store.park(run.id, token, 'escalated');
      } else await this.store.park(run.id, token, 'waiting_approval');
      return { kind: 'park' };
    }
    const op = prepared.operation!;
    if (op.status === 'SUCCEEDED') return { kind: 'result',
      result: { status: 'REFUND_SUCCEEDED', operationId: op.id, idempotencyKey: op.idempotencyKey } };
    if (op.status === 'UNKNOWN' || op.status === 'IN_FLIGHT') {
      await this.store.park(run.id, token, 'waiting_external', new Date(Date.now() + 2000));
      return { kind: 'park' };
    }
    if (op.status === 'RETRY_SCHEDULED' && op.nextActionAt && op.nextActionAt.getTime() > Date.now()) {
      await this.store.park(run.id, token, 'retry_scheduled', op.nextActionAt);
      return { kind: 'park' };
    }
    const attempt = await this.store.beginAttempt(op.id);
    if (!attempt) {
      await this.store.park(run.id, token, 'waiting_external', new Date(Date.now() + 2000));
      return { kind: 'park' };
    }
    const providerOutcome = await this.provider.refund(run, attempt);
    if (providerOutcome === 'SUCCESS') {
      await this.store.markOperation(op.id, 'SUCCEEDED', null);
      return { kind: 'result', result: { status: 'REFUND_SUCCEEDED',
        operationId: op.id, idempotencyKey: op.idempotencyKey } };
    }
    if (providerOutcome === '503') {
      if (attempt.attemptCount >= MAX_RETRIES) {
        await this.store.park(run.id, token, 'escalated');
        return { kind: 'park' };
      }
      const next = new Date(Date.now() + 1000 * Math.pow(2, attempt.attemptCount));
      await this.store.markOperation(op.id, 'RETRY_SCHEDULED', next, 'Mock provider returned 503');
      await this.store.park(run.id, token, 'retry_scheduled', next);
      return { kind: 'park' };
    }
    const next = new Date(Date.now() + 2000);
    await this.store.markOperation(op.id, 'UNKNOWN', next, 'Mock response timed out after provider commit');
    await this.store.park(run.id, token, 'waiting_external', next);
    return { kind: 'park' };
  }
}
