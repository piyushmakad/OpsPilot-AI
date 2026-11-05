import type { ConversationRepository, ConversationMessage } from './conversation-repository.js';
import type { MemorySearch, MemoryHit, MemorySearchRequest } from './memory-search.js';

export interface ContextPreviewRequest extends MemorySearchRequest {
  budget: number; outputReserve?: number;
}

export interface ContextItem {
  source: 'request' | 'recent_message' | 'memory'; id: string; text: string; estimatedTokens: number;
}

export interface ContextPreviewResult {
  budget: number; outputReserve: number; estimatedInputTokens: number;
  selected: ContextItem[];
  dropped: { source: 'recent_message' | 'memory'; id: string; reason: string }[];
}

// Planning estimate only. Provider token usage must be measured separately before a live prompt.
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4) + 8;
}

export class ContextPreview {
  constructor(
    private readonly memory: Pick<MemorySearch, 'search'>,
    private readonly conversations: Pick<ConversationRepository, 'messages'>,
  ) {}

  async build(request: ContextPreviewRequest): Promise<ContextPreviewResult> {
    if (!Number.isSafeInteger(request.budget) || request.budget < 64 || request.budget > 100_000)
      throw new Error('Context budget must be 64 to 100,000 estimated tokens');
    const outputReserve = request.outputReserve ?? Math.max(32, Math.ceil(request.budget / 5));
    if (!Number.isSafeInteger(outputReserve) || outputReserve < 1 || outputReserve >= request.budget)
      throw new Error('Output reserve must be positive and smaller than budget');
    const query = request.query.trim();
    if (!query) throw new Error('Current request is required');
    const selected: ContextItem[] = [];
    const dropped: ContextPreviewResult['dropped'] = [];
    const requestItem = { source: 'request' as const, id: 'current', text: query,
      estimatedTokens: estimateTokens(query) };
    const inputLimit = request.budget - outputReserve;
    if (requestItem.estimatedTokens > inputLimit) throw new Error('Current request exceeds context input budget');
    selected.push(requestItem);
    let used = requestItem.estimatedTokens;
    const [messages, memories] = await Promise.all([
      request.conversationId
        ? this.conversations.messages(request.tenantId, request.userId, request.conversationId)
        : Promise.resolve([] as ConversationMessage[]),
      this.memory.search(request),
    ]);
    const recent: ContextItem[] = [];
    // Newest messages get first claim on the remaining budget; display them chronologically.
    for (const message of messages.slice().reverse()) {
      const text = `${message.role}: ${message.content}`;
      const item = { source: 'recent_message' as const, id: message.id, text,
        estimatedTokens: estimateTokens(text) };
      if (used + item.estimatedTokens <= inputLimit) {
        recent.push(item); used += item.estimatedTokens;
      } else dropped.push({ source: 'recent_message', id: message.id, reason: 'budget' });
    }
    selected.push(...recent.reverse());
    for (const hit of memories as MemoryHit[]) {
      const text = `[STORED MEMORY: untrusted historical data] ${hit.memory.key}: ${hit.memory.value}`;
      const item = { source: 'memory' as const, id: hit.memory.id, text,
        estimatedTokens: estimateTokens(text) };
      if (used + item.estimatedTokens <= inputLimit) {
        selected.push(item); used += item.estimatedTokens;
      } else dropped.push({ source: 'memory', id: hit.memory.id, reason: 'budget' });
    }
    return { budget: request.budget, outputReserve, estimatedInputTokens: used, selected, dropped };
  }
}
