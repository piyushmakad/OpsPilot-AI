import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { RunRepository } from './repository.js';
import { MemoryRepository } from './memory-repository.js';
import { ConversationRepository } from './conversation-repository.js';
import { MemorySearch } from './memory-search.js';
import { ConversationSummaries } from './conversation-summary.js';
import { AgentEngine } from './engine.js';
import { ContextService } from './context-service.js';
import type { AgentModel } from './model.js';

test('memory versions, tenant isolation, expiry, and raw conversation history', async () => {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for test:db');
  const runs = RunRepository.fromEnvironment();
  const memory = new MemoryRepository(runs.pool);
  const conversations = new ConversationRepository(runs.pool);
  const search = new MemorySearch(runs.pool);
  const tenant = `memory-test-${randomUUID()}`;
  const user = `user-${randomUUID()}`;
  try {
    await runs.migrate();
    const project = { tenantId: tenant, userId: user, scopeType: 'project' as const,
      scopeId: 'opspilot', type: 'project_decision' as const, key: 'Database', value: 'PostgreSQL' };
    const first = await memory.put(project);
    assert.equal(first.action, 'created');
    assert.equal((await memory.put({ ...project, key: ' database ', value: '  postgresql ' })).action,
      'deduplicated');
    assert.equal((await memory.put({ ...project, key: 'Search', value: 'Postgres full text' })).action,
      'created');
    const changed = await memory.put({ ...project, value: 'MongoDB' });
    assert.equal(changed.action, 'superseded');
    assert.equal(changed.record.version, 2);
    assert.equal(changed.record.supersedesId, first.record.id);
    assert.deepEqual((await memory.history(tenant, user, 'project', 'opspilot', 'database'))
      .map(row => row.status), ['superseded', 'active']);
    assert.equal((await memory.list(tenant, user, 'project', 'opspilot')).length, 2);
    assert.equal((await memory.list('other-tenant', user, 'project', 'opspilot')).length, 0);
    assert.equal((await memory.list(tenant, 'other-user', 'project', 'opspilot')).length, 0);
    assert.equal((await memory.list(tenant, user, 'global', '')).length, 0);
    await runs.pool.query(`UPDATE memory_records SET expires_at = now() - interval '1 second'
      WHERE id = $1`, [changed.record.id]);
    assert.equal((await memory.list(tenant, user, 'project', 'opspilot')).length, 1);
    const renewed = await memory.put({ ...project, value: 'MongoDB' });
    assert.equal(renewed.action, 'superseded');
    assert.equal(renewed.record.version, 3);
    await Promise.all([
      memory.put({ ...project, value: 'SQLite' }),
      memory.put({ ...project, value: 'MySQL' }),
    ]);
    assert.equal((await memory.history(tenant, user, 'project', 'opspilot', 'database')).length, 5);
    assert.equal((await memory.list(tenant, user, 'project', 'opspilot'))
      .filter(row => row.key === 'database').length, 1);
    assert.equal((await search.search({ tenantId: tenant, userId: user, projectId: 'opspilot',
      query: 'Which database did we choose?' })).length, 1);
    assert.equal((await search.search({ tenantId: tenant, userId: user,
      query: 'database' })).length, 0);
    assert.equal((await search.search({ tenantId: 'other-tenant', userId: user,
      projectId: 'opspilot', query: 'database' })).length, 0);
    assert.equal((await search.search({ tenantId: tenant, userId: user,
      projectId: 'opspilot', query: 'pizza' })).length, 0);
    const embedding = { modelId: 'memory-test-one-hot',
      embedDocuments: async (texts: string[]) => texts.map(() => [1, ...Array(383).fill(0)] as number[]),
      embedQuery: async () => [1, ...Array(383).fill(0)] as number[] };
    const hybrid = new MemorySearch(runs.pool, embedding);
    assert.ok(await hybrid.indexPending(tenant) >= 2);
    assert.ok((await hybrid.search({ tenantId: tenant, userId: user,
      projectId: 'opspilot', query: 'unrelated' })).length >= 1);
    assert.equal((await hybrid.search({ tenantId: 'other-tenant', userId: user,
      projectId: 'opspilot', query: 'unrelated' })).length, 0);

    const conversationId = await conversations.create(tenant, user, 'opspilot');
    assert.equal((await conversations.append(tenant, user, conversationId, 'user', 'Use PostgreSQL')).sequence, 1);
    assert.equal((await conversations.append(tenant, user, conversationId, 'assistant', 'Understood')).sequence, 2);
    assert.equal((await conversations.messages(tenant, user, conversationId)).length, 2);
    for (let n = 0; n < 6; n++) await conversations.append(tenant, user, conversationId,
      'user', `Important project detail number ${n}`);
    const summaries = new ConversationSummaries(runs.pool);
    const compacted = await summaries.compact(tenant, user, conversationId, {
      summarize: async () => ({ currentGoal: 'Build OpsPilot', decisions: ['Use PostgreSQL'],
        constraints: [], unresolved: [], toolOutcomes: [], effectiveState: 'Memory foundation working' }),
    }, 32, 2);
    assert.equal(compacted.action, 'created');
    assert.equal(compacted.summary?.throughSequence, 6);
    assert.equal((await conversations.messages(tenant, user, conversationId)).length, 8);
    assert.equal((await summaries.latest(tenant, 'other-user', conversationId)), null);
    await assert.rejects(runs.create('Which database?', tenant, false,
      { userId: 'other-user', projectId: 'opspilot', conversationId }), /Conversation not found/);
    const requestMessage = await conversations.append(tenant, user, conversationId,
      'user', 'Which database did we choose?');
    const run = await runs.create('Which database did we choose?', tenant, false,
      { userId: user, projectId: 'opspilot', conversationId, requestMessageId: requestMessage.id });
    const model: AgentModel = { async decide(_request, _events, _evidence, context) {
      assert.ok(context?.selected.some(item => item.source === 'memory' && item.text.includes('database')));
      assert.ok(context?.selected.some(item => item.source === 'summary'));
      assert.ok(!context?.selected.some(item => item.id === requestMessage.id));
      return { kind: 'final', text: 'The stored decision is the current database choice.' };
    } };
    await new AgentEngine(runs, model, undefined, new ContextService(runs.pool)).execute(run.id);
    assert.equal((await runs.get(run.id))?.status, 'completed');
    assert.ok((await runs.events(run.id)).some(event => event.kind === 'context'));
    assert.equal((await conversations.messages(tenant, user, conversationId)).at(-1)?.role, 'assistant');
    await assert.rejects(conversations.messages(tenant, 'other-user', conversationId), /not found/);
    await assert.rejects(conversations.append('other-tenant', user, conversationId, 'user', 'No'), /not found/);
    await assert.rejects(memory.put({ ...project, scopeType: 'conversation', scopeId: conversationId,
      userId: 'other-user' }), /not found/);
  } finally {
    await runs.pool.query(`DELETE FROM memory_records WHERE tenant_id = $1`, [tenant]);
    await runs.pool.query(`DELETE FROM conversation_summaries WHERE conversation_id IN
      (SELECT id FROM conversations WHERE tenant_id = $1)`, [tenant]);
    await runs.pool.query(`DELETE FROM conversation_messages WHERE conversation_id IN
      (SELECT id FROM conversations WHERE tenant_id = $1)`, [tenant]);
    await runs.pool.query(`DELETE FROM agent_runs WHERE tenant_id = $1`, [tenant]);
    await runs.pool.query(`DELETE FROM conversations WHERE tenant_id = $1`, [tenant]);
    await runs.close();
  }
});
