import assert from 'node:assert/strict';
import test from 'node:test';
import { chunkMarkdown } from './knowledge-chunk.js';

test('preserves heading boundaries and paragraph text', () => {
  const chunks = chunkMarkdown('# Refunds\n\nEnterprise customers have 45 days.\n\n## Exceptions\n\nFraud is excluded.');
  assert.deepEqual(chunks.map(chunk => chunk.section), ['Refunds', 'Exceptions']);
  assert.match(chunks[0]!.content, /45 days/);
  assert.match(chunks[1]!.content, /Fraud/);
});

test('limits chunk size and keeps overlap within a long section', () => {
  const words = Array.from({ length: 180 }, (_, index) => `word${index}`).join(' ');
  const chunks = chunkMarkdown(`# Policy\n\n${words}`, { maxChars: 250, overlapChars: 40 });
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every(chunk => chunk.content.length <= 250));
  assert.ok(chunks.every(chunk => chunk.section === 'Policy'));
});
