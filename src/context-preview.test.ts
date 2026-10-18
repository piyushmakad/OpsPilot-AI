import assert from 'node:assert/strict';
import test from 'node:test';
import { ContextPreview } from './context-preview.js';
import { searchTerms } from './memory-search.js';
import type { MemoryHit } from './memory-search.js';
import type { ConversationMessage } from './conversation-repository.js';

const now = new Date();
const messages: ConversationMessage[] = [
  { id: 'old', sequence: 1, role: 'user', content: 'Long earlier message about deployment details', createdAt: now },
  { id: 'new', sequence: 2, role: 'user', content: 'Database?', createdAt: now },
];
const hit: MemoryHit = { lexicalRank: 0.5, semanticSimilarity: null, score: 0.8, memory: {
  id: 'fact', tenantId: 't', userId: 'u', scopeType: 'project', scopeId: 'opspilot',
  type: 'project_decision', key: 'database', value: 'PostgreSQL', status: 'active',
  sourceType: 'user_message', importance: 0.9, confidence: 1, version: 1,
  supersedesId: null, createdAt: now, updatedAt: now,
} };

test('query terms keep meaningful words for OR keyword search', () => {
  assert.deepEqual(searchTerms('What database did we choose for OpsPilot?'), ['database', 'choose', 'opspilot']);
});

test('context preview reserves output and favors newest raw messages under a tight budget', async () => {
  const builder = new ContextPreview({ search: async () => [hit] }, { messages: async () => messages });
  const result = await builder.build({ tenantId: 't', userId: 'u', projectId: 'opspilot',
    conversationId: 'conversation', query: 'Database?', budget: 64 });
  assert.ok(result.estimatedInputTokens + result.outputReserve <= result.budget);
  assert.ok(result.selected.some(item => item.id === 'new'));
  assert.ok(result.dropped.some(item => item.id === 'fact' && item.reason === 'budget'));
});

test('context preview includes relevant memory when there is room', async () => {
  const builder = new ContextPreview({ search: async () => [hit] }, { messages: async () => [] });
  const result = await builder.build({ tenantId: 't', userId: 'u', projectId: 'opspilot',
    query: 'Which database?', budget: 200 });
  assert.ok(result.selected.some(item => item.source === 'memory' && item.text.includes('PostgreSQL')));
});
