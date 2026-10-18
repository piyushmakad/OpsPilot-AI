import type pg from 'pg';
import type { AgentRun, RunEvent } from './types.js';
import type { EvidenceSnapshot } from './evidence.js';
import { MemorySearch } from './memory-search.js';
import { ConversationRepository } from './conversation-repository.js';
import { ConversationSummaries } from './conversation-summary.js';
import { buildContext, type ContextSnapshot } from './context-builder.js';
import { BgeSmallEmbeddings } from './embedding.js';
import type { ConversationMessage } from './conversation-repository.js';

export function excludeCurrentRequest(messages: ConversationMessage[], requestMessageId: string | null | undefined):
  ConversationMessage[] {
  return requestMessageId ? messages.filter(message => message.id !== requestMessageId) : messages;
}

export class ContextService {
  private readonly memories: MemorySearch;
  private readonly conversations: ConversationRepository;
  private readonly summaries: ConversationSummaries;
  constructor(pool: pg.Pool) {
    this.memories = new MemorySearch(pool,
      process.env.MEMORY_SEMANTIC === '1' ? new BgeSmallEmbeddings() : undefined);
    this.conversations = new ConversationRepository(pool);
    this.summaries = new ConversationSummaries(pool);
  }

  async warmup(run: AgentRun): Promise<void> {
    if (run.actorId && process.env.MEMORY_SEMANTIC === '1') await this.memories.warmup();
  }

  async build(run: AgentRun, events: RunEvent[], evidence: EvidenceSnapshot | null): Promise<ContextSnapshot> {
    const user = run.actorId;
    const [messages, summary, memories] = await Promise.all([
      user && run.conversationId
        ? this.conversations.recentMessages(run.tenantId, user, run.conversationId) : Promise.resolve([]),
      user && run.conversationId
        ? this.summaries.latest(run.tenantId, user, run.conversationId) : Promise.resolve(null),
      user ? this.memories.search({ tenantId: run.tenantId, userId: user,
        projectId: run.projectId ?? undefined, conversationId: run.conversationId ?? undefined,
        query: run.requestText.slice(0, 2000), limit: 10 }) : Promise.resolve([]),
    ]);
    return buildContext({ run, events, evidence,
      messages: excludeCurrentRequest(messages, run.requestMessageId), summary, memories,
      budget: process.env.CONTEXT_TOKEN_BUDGET ? Number(process.env.CONTEXT_TOKEN_BUDGET) : undefined });
  }
}
