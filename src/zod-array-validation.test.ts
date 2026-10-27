import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';

test('oversized validated arrays fail size checks before elements are parsed (GHSA-mrhx-c7xc-m3w5)', () => {
  let parsed = 0;
  const element = z.number().refine(() => {
    parsed += 1;
    return true;
  });
  const result = z.array(element).max(2, 'too many').safeParse([1, 2, 3]);
  assert.equal(result.success, false);
  // Fixed versions bail on an upper-bound size violation before touching any element,
  // so no validation issue is accumulated per failing element (CVE-2023-54404).
  assert.equal(parsed, 0);
  assert.deepEqual(result.error.issues, [{
    origin: 'array', code: 'too_big', maximum: 2, inclusive: true, path: [], message: 'too many',
  }]);
});
