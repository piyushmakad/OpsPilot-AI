import { decisionSchema } from './types.js';
import type { Decision } from './types.js';
import type { AgentModel } from './model.js';
import { RunRepository } from './repository.js';

const MAX_MODEL_DECISIONS = 5;

export class AgentEngine {
  constructor(private readonly repository: RunRepository, private readonly model: AgentModel) {}

  async execute(runId: string): Promise<void> {
    const token = await this.repository.claim(runId);
    if (!token) throw new Error('Run is complete or currently claimed by another worker');
    try {
      while (true) {
        const run = await this.repository.get(runId);
        if (!run) throw new Error('Run not found');
        const events = await this.repository.events(runId);
        const latest = events.at(-1);

        if (latest?.kind === 'decision') {
          const decision = decisionSchema.parse(latest.payload);
          if (decision.kind === 'final') {
            await this.repository.finish(runId, token, 'completed', decision.text);
            return;
          }
          const result = executeReadOnlyTool(decision);
          await this.repository.append(runId, token, 'tool_result', { tool: decision.tool, result });
          continue;
        }

        if (events.filter(e => e.kind === 'decision').length >= MAX_MODEL_DECISIONS) {
          await this.repository.finish(runId, token, 'failed', 'Model decision limit reached');
          return;
        }
        const decision = decisionSchema.parse(await this.model.decide(run.requestText, events));
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
