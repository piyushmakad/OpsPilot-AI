import type { AgentRun } from './types.js';
import type { Operation, WorkflowStore } from './workflow-store.js';

export type ProviderOutcome = 'SUCCESS' | '503' | 'UNKNOWN';

/** The runtime handles durable attempts and retries; the provider reports one attempt's outcome. */
export interface RefundProvider {
  refund(run: AgentRun, operation: Operation): Promise<ProviderOutcome>;
  reconcile(run: AgentRun): Promise<void>;
}

/** Local simulation only. A real adapter would call the provider with operation.idempotencyKey. */
export class MockRefundProvider implements RefundProvider {
  constructor(private readonly store: WorkflowStore) {}
  refund(run: AgentRun, operation: Operation): Promise<ProviderOutcome> {
    return this.store.applyMockProvider(run, operation);
  }
  reconcile(run: AgentRun): Promise<void> {
    return this.store.reconcile(run);
  }
}
