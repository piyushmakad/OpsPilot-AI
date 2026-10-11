import { decisionSchema } from './types.js';
import type { Decision } from './types.js';
import type { AgentModel } from './model.js';
import { RunRepository } from './repository.js';
import type { KnowledgeSearch } from './retrieval.js';
import { evidenceSnapshotSchema, formatGroundedFinal, selectEvidence } from './evidence.js';

const MAX_MODEL_DECISIONS = 5;

export class AgentEngine {
  constructor(
    private readonly repository: RunRepository,
    private readonly model: AgentModel,
    private readonly knowledge?: Pick<KnowledgeSearch, 'warmup' | 'search'>,
  ) {}

  async execute(runId: string): Promise<void> {
    const initialRun = await this.repository.get(runId);
    if (!initialRun) throw new Error('Run not found');
    if (initialRun.ragEnabled) {
      if (!this.knowledge) throw new Error('RAG run requires a knowledge retriever');
      const hasSnapshot = (await this.repository.events(runId)).some(event => event.kind === 'retrieval');
      // Model download may outlast the run lease, so warm up before claiming it.
      if (!hasSnapshot) await this.knowledge.warmup();
    }
    const token = await this.repository.claim(runId);
    if (!token) throw new Error('Run is complete or currently claimed by another worker');
    try {
      while (true) {
        const run = await this.repository.get(runId);
        if (!run) throw new Error('Run not found');
        const events = await this.repository.events(runId);
        const latest = events.at(-1);
        const retrievalEvent = events.find(event => event.kind === 'retrieval');
        if (run.ragEnabled && !retrievalEvent) {
          const candidates = await this.knowledge!.search(run.tenantId, run.requestText);
          const snapshot = selectEvidence(run.requestText, run.tenantId, candidates);
          await this.repository.append(runId, token, 'retrieval', snapshot);
          continue;
        }
        const evidence = retrievalEvent ? evidenceSnapshotSchema.parse(retrievalEvent.payload) : null;
        if (evidence && (evidence.tenantId !== run.tenantId || evidence.query !== run.requestText)) {
          throw new Error('Persisted retrieval does not match this run');
        }
        if (run.ragEnabled && evidence?.status === 'insufficient_evidence') {
          await this.repository.finish(runId, token, 'completed',
            'I do not have enough relevant knowledge to answer this request.');
          return;
        }

        if (latest?.kind === 'decision') {
          const decision = decisionSchema.parse(latest.payload);
          if (decision.kind === 'final') {
            const text = run.ragEnabled
              ? formatGroundedFinal(decision, evidence!) : decision.text;
            await this.repository.finish(runId, token, 'completed', text);
            return;
          }
          if (run.ragEnabled) throw new Error('Demo policy tool is unavailable in a grounded run');
          const result = executeReadOnlyTool(decision);
          await this.repository.append(runId, token, 'tool_result', { tool: decision.tool, result });
          continue;
        }

        if (events.filter(e => e.kind === 'decision').length >= MAX_MODEL_DECISIONS) {
          await this.repository.finish(runId, token, 'failed', 'Model decision limit reached');
          return;
        }
        const decision = decisionSchema.parse(await this.model.decide(run.requestText, events, evidence));
        if (run.ragEnabled && decision.kind === 'tool') {
          throw new Error('Demo policy tool is unavailable in a grounded run');
        }
        if (run.ragEnabled && decision.kind === 'final') {
          formatGroundedFinal(decision, evidence!);
        }
        await this.repository.append(runId, token, 'decision', decision);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      try { await this.repository.finish(runId, token, 'failed', message); } catch { /* lease may have moved */ }
      throw error;
    }
  }
}

function executeReadOnlyTool(decision: Extract<Decision, { kind: 'tool' }>): string {
  switch (decision.tool) {
    case 'get_demo_policy':
      return 'Demo data only: contact support within 30 days of purchase. Eligibility requires human review.';
  }
}
