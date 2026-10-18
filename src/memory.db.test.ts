import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { RunRepository } from './repository.js';
import { MemoryRepository } from './memory-repository.js';
import { ConversationRepository } from './conversation-repository.js';

test('memory versions, tenant isolation, expiry, and raw conversation history', async () => {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for test:db');
  const runs = RunRepository.fromEnvironment();
  const memory = new MemoryRepository(runs.pool);
  const conversations = new ConversationRepository(runs.pool);
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

    const conversationId = await conversations.create(tenant, user, 'opspilot');
    assert.equal((await conversations.append(tenant, user, conversationId, 'user', 'Use PostgreSQL')).sequence, 1);
    assert.equal((await conversations.append(tenant, user, conversationId, 'assistant', 'Understood')).sequence, 2);
    assert.equal((await conversations.messages(tenant, user, conversationId)).length, 2);
    await assert.rejects(conversations.messages(tenant, 'other-user', conversationId), /not found/);
    await assert.rejects(conversations.append('other-tenant', user, conversationId, 'user', 'No'), /not found/);
    await assert.rejects(memory.put({ ...project, scopeType: 'conversation', scopeId: conversationId,
      userId: 'other-user' }), /not found/);
  } finally {
    await runs.pool.query(`DELETE FROM memory_records WHERE tenant_id = $1`, [tenant]);
    await runs.pool.query(`DELETE FROM conversation_messages WHERE conversation_id IN
      (SELECT id FROM conversations WHERE tenant_id = $1)`, [tenant]);
    await runs.pool.query(`DELETE FROM conversations WHERE tenant_id = $1`, [tenant]);
    await runs.close();
  }
});
