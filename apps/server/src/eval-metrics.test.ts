import assert from 'node:assert/strict';
import test from 'node:test';
import { compareToBaseline, labelRanks, matchesPattern, percentile, scoreRetrievalCase,
  summarizeRetrieval, type Label } from './eval-metrics.js';

const hits = [
  { documentKey: 'billing', section: 'Taxes' },
  { documentKey: 'refund', section: 'Eligibility' },
  { documentKey: 'refund', section: 'Annual plans' },
];

test('ranks are 1-based and missing labels are null', () => {
  assert.deepEqual(labelRanks(hits, [['refund', 'eligibility'], ['sso', 'Okta']]), [2, null]);
});

test('a case scores hit@1, hit@k, recall@k, and reciprocal rank', () => {
  const relevant: Label[] = [['refund', 'Eligibility'], ['refund', 'Annual plans']];
  assert.deepEqual(scoreRetrievalCase(hits, relevant, 5),
    { answerable: true, abstained: false, hitAt1: 0, hitAtK: 1, recallAtK: 1, reciprocalRank: 0.5 });
  assert.equal(scoreRetrievalCase(hits, relevant, 2).recallAtK, 0.5);
  assert.equal(scoreRetrievalCase(hits, [['sso', 'Okta']], 5).reciprocalRank, 0);
});

test('an empty result on a no-answer case counts as a correct abstention', () => {
  const summary = summarizeRetrieval([
    { category: 'keyword', score: scoreRetrievalCase(hits, [['billing', 'Taxes']], 5), latencyMs: 10, leaks: 0 },
    { category: 'keyword', score: scoreRetrievalCase([], [['refund', 'Eligibility']], 5), latencyMs: 30, leaks: 0 },
    { category: 'no_answer', score: scoreRetrievalCase([], [], 5), latencyMs: 20, leaks: 0 },
    { category: 'no_answer', score: scoreRetrievalCase(hits, [], 5), latencyMs: 40, leaks: 1 },
  ]);
  assert.equal(summary.n, 2);
  assert.equal(summary.mrr, 0.5);
  assert.equal(summary.falseAbstentionRate, 0.5);
  assert.equal(summary.correctAbstentionRate, 0.5);
  assert.equal(summary.leaks, 1);
  assert.deepEqual(summary.latencyMs, { p50: 20, p95: 40 });
});

test('baseline comparison flags drops beyond tolerance and any leak', () => {
  const current = summarizeRetrieval([
    { category: 'keyword', score: scoreRetrievalCase(hits, [['refund', 'Eligibility']], 5), latencyMs: 1, leaks: 0 },
  ]);
  assert.deepEqual(compareToBaseline(current, { mrr: 0.52, hitAtK: 1 }), []);
  assert.equal(compareToBaseline(current, { mrr: 0.9 }).length, 1);
  assert.equal(compareToBaseline({ ...current, leaks: 2 }, {}).length, 1);
});

test('percentile and pattern helpers', () => {
  assert.equal(percentile([5, 1, 3, 2, 4], 50), 3);
  assert.equal(percentile([], 95), 0);
  assert.ok(matchesPattern('Limit is 3,000 per minute', '3000|3,000'));
  assert.ok(!matchesPattern('Limit is 600', '3000|3,000'));
});
