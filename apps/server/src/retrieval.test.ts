import assert from 'node:assert/strict';
import test from 'node:test';
import { fuseCandidates } from './retrieval.js';

const candidate = (chunkId: string, score: number) => ({
  chunkId, documentId: 'document-1', documentKey: 'refund-enterprise',
  version: 2, title: 'Enterprise refunds', section: 'Eligibility',
  source: 'policies/refunds.md', content: 'Enterprise customers have 45 days.', score,
});

test('combines semantic and lexical hits and keeps citation metadata', () => {
  const hits = fuseCandidates(
    [candidate('both', 0.72), candidate('semantic', 0.69)],
    [candidate('both', 0.12), candidate('lexical', 0.08)],
  );
  assert.equal(hits[0]?.chunkId, 'both');
  assert.equal(hits[0]?.source, 'policies/refunds.md');
  assert.equal(hits[0]?.documentKey, 'refund-enterprise');
  assert.equal(hits[0]?.semanticScore, 0.72);
  assert.equal(hits[0]?.lexicalScore, 0.12);
});

test('rejects low-relevance candidates and returns no evidence', () => {
  const hits = fuseCandidates([candidate('weak', 0.4)], [candidate('noise', 0.001)]);
  assert.deepEqual(hits, []);
});

test('keeps a strong exact lexical hit when semantic search misses it', () => {
  const hits = fuseCandidates([], [candidate('policy-id', 10)]);
  assert.equal(hits[0]?.chunkId, 'policy-id');
  assert.equal(hits[0]?.semanticScore, null);
});
