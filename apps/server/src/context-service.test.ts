import assert from 'node:assert/strict';
import test from 'node:test';
import { excludeCurrentRequest } from './context-service.js';
import type { ConversationMessage } from './conversation-repository.js';

test('only the linked request message is removed from recent history', () => {
  const now = new Date();
  const messages: ConversationMessage[] = [
    { id: 'earlier', sequence: 1, role: 'user', content: 'Which database?', createdAt: now },
    { id: 'current', sequence: 2, role: 'user', content: 'Which database?', createdAt: now },
  ];
  assert.deepEqual(excludeCurrentRequest(messages, 'current').map(message => message.id), ['earlier']);
  assert.equal(excludeCurrentRequest(messages, null).length, 2);
});
