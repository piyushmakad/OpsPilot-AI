import assert from 'node:assert/strict';
import test from 'node:test';
import { MemoryWritePipeline, type MemoryCandidate } from './memory-extraction.js';
import type { ConversationRepository } from './conversation-repository.js';
import type { MemoryRepository, MemoryInput } from './memory-repository.js';

const candidate = (overrides: Partial<MemoryCandidate> = {}): MemoryCandidate => ({
  type: 'project_decision', scopeType: 'project', key: 'database', value: 'PostgreSQL',
  evidenceQuote: 'For OpsPilot use PostgreSQL', importance: 0.9, confidence: 0.95,
  ttlDays: null, ...overrides,
});

test('memory pipeline fixes identity, requires quoted evidence, and ignores low-value chatter', async () => {
  const writes: MemoryInput[] = [];
  const conversations = { get: async () => ({ projectId: 'opspilot' }),
    append: async () => ({ id: 'message-1', sequence: 1 }) } as unknown as ConversationRepository;
  const memories = { put: async (input: MemoryInput) => {
    writes.push(input);
    return { action: 'created', record: { ...input, id: 'memory-1', key: input.key,
      version: 1, status: 'active', supersedesId: null, createdAt: new Date(), updatedAt: new Date() } };
  } } as unknown as MemoryRepository;
  const pipeline = new MemoryWritePipeline(conversations, memories, { extract: async () => [
    candidate(),
    candidate({ key: 'invented', evidenceQuote: 'MongoDB' }),
    candidate({ key: 'pizza', evidenceQuote: 'For OpsPilot', confidence: 0.2 }),
  ] });
  const result = await pipeline.learn({ tenantId: 'tenant-a', userId: 'user-a',
    projectId: 'opspilot', conversationId: 'conversation-a', message: 'For OpsPilot use PostgreSQL' });
  assert.deepEqual(result.created, ['database']);
  assert.deepEqual(result.ignored, ['invented', 'pizza']);
  assert.equal(writes.length, 1);
  assert.equal(writes[0]?.tenantId, 'tenant-a');
  assert.equal(writes[0]?.userId, 'user-a');
  assert.equal(writes[0]?.scopeId, 'opspilot');
  assert.equal(writes[0]?.sourceId, 'message-1');
  assert.equal(writes[0]?.sourceType, 'user_message');
});
