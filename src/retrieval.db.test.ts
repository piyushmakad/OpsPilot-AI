import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import type { EmbeddingProvider } from './embedding.js';
import { KnowledgeRepository } from './knowledge-repository.js';
import { KnowledgeSearch } from './retrieval.js';

const { Pool } = pg;
const vector = (axis: number): number[] => Array.from({ length: 384 }, (_, index) => index === axis ? 1 : 0);
const fakeEmbeddings: EmbeddingProvider = {
  modelId: 'test-embedding-v1',
  async embedDocuments(texts) {
    return texts.map(text => vector(text.toLowerCase().includes('refund') ? 0 : 1));
  },
  async embedQuery(query) {
    return vector(query.includes('refund') ? 0 : 2);
  },
};

test('PostgreSQL retrieval enforces tenant and active-version filters', async () => {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for test:db');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const repository = new KnowledgeRepository(pool);
  const search = new KnowledgeSearch(pool, fakeEmbeddings);
  const tenantA = `test-${randomUUID()}`;
  const tenantB = `test-${randomUUID()}`;
  try {
    await repository.ingest({ tenantId: tenantA, documentKey: 'refund', version: 1,
      title: 'Refund policy', source: 'old.md', status: 'ACTIVE',
      markdown: '# Refund policy\n\nEnterprise refunds were allowed for 10 days.' });
    await repository.ingest({ tenantId: tenantA, documentKey: 'refund', version: 2,
      title: 'Refund policy', source: 'current.md', status: 'ACTIVE',
      markdown: '# Refund policy\n\nEnterprise refunds are allowed for 45 days.' });
    await repository.ingest({ tenantId: tenantA, documentKey: 'password', version: 1,
      title: 'Password reset', source: 'password.md', status: 'ACTIVE',
      markdown: '# Password reset\n\nUsers can reset passwords from the account page.' });
    await repository.ingest({ tenantId: tenantB, documentKey: 'refund', version: 1,
      title: 'Refund policy', source: 'other-tenant.md', status: 'ACTIVE',
      markdown: '# Refund policy\n\nEnterprise refunds are allowed for 90 days.' });

    assert.equal(await search.indexPending(tenantA), 2);
    assert.equal(await search.indexPending(tenantB), 1);
    const hits = await search.search(tenantA, 'enterprise refund');
    assert.ok(hits.length > 0);
    assert.ok(hits.every(hit => hit.source !== 'old.md' && hit.source !== 'other-tenant.md'));
    assert.equal(hits[0]?.source, 'current.md');
    assert.equal(hits[0]?.version, 2);
    assert.deepEqual(await search.search(tenantA, 'bananas'), []);
  } finally {
    await pool.query('DELETE FROM knowledge_documents WHERE tenant_id = ANY($1::text[])', [[tenantA, tenantB]]);
    await pool.end();
  }
});
