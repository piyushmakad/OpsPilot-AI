import assert from 'node:assert/strict';
import test from 'node:test';
import { memoryFingerprint, normalizeMemoryKey } from './memory-repository.js';

test('fact keys and values normalize consistently without losing the stored value', () => {
  assert.equal(normalizeMemoryKey('  Database   Choice '), 'database_choice');
  assert.equal(memoryFingerprint('PostgreSQL', 'project_decision'),
    memoryFingerprint('  postgresql  ', 'project_decision'));
  assert.notEqual(memoryFingerprint('PostgreSQL', 'project_decision'),
    memoryFingerprint('MongoDB', 'project_decision'));
  assert.notEqual(memoryFingerprint('PostgreSQL', 'project_decision'),
    memoryFingerprint('PostgreSQL', 'user_preference'));
});
