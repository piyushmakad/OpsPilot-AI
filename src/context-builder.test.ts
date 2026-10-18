import assert from 'node:assert/strict';
import test from 'node:test';
import { buildContext } from './context-builder.js';
import type { AgentRun, RunEvent } from './types.js';
import type { MemoryHit } from './memory-search.js';
import type { EvidenceSnapshot } from './evidence.js';

const now = new Date();
const run: AgentRun = { id: 'run-1', tenantId: 'tenant-a', requestText: 'What is my payment status?',
  ragEnabled: true, status: 'running', outputText: null, errorText: null, leaseToken: null,
  leaseExpiresAt: null, workflowVersion: 2, actorId: 'user-a', projectId: 'opspilot',
  conversationId: null, scenario: null, nextActionAt: null, createdAt: now, updatedAt: now };
const hit = (key: string, type: MemoryHit['memory']['type'], value: string): MemoryHit => ({
  score: 1, lexicalRank: 0.5, semanticSimilarity: null,
  memory: { id: key, tenantId: 'tenant-a', userId: 'user-a', scopeType: 'project',
    scopeId: 'opspilot', type, key, value, status: 'active', version: 1,
    supersedesId: null, importance: 0.8, confidence: 1, sourceType: 'user_message',
    createdAt: now, updatedAt: now },
});
const evidence: EvidenceSnapshot = { query: run.requestText, tenantId: run.tenantId,
  status: 'evidence_found', candidates: [], selected: [{ id: 'S1', chunkId: 'c1', documentId: 'd1',
    documentKey: 'refund-policy', version: 1, title: 'Refund policy', section: 'Eligibility',
    source: 'policy.md', content: 'Refunds require a successful payment.' }] };
const events: RunEvent[] = [{ runId: run.id, sequence: 1, kind: 'tool_result',
  payload: { facts: { payment_status: 'REFUNDED' } }, createdAt: now }];

test('current tool facts and policy evidence suppress stale conflicting memory', () => {
  const context = buildContext({ run, events, evidence, messages: [], summary: null,
    memories: [hit('payment_status', 'semantic', 'PENDING'),
      hit('refund_policy', 'procedural', 'Always refund'),
      hit('response_style', 'user_preference', 'Concise')] });
  assert.ok(context.selected.some(item => item.source === 'tool_result'));
  assert.ok(context.selected.some(item => item.source === 'rag'));
  assert.ok(context.selected.some(item => item.id === 'response_style'));
  assert.ok(context.dropped.some(item => item.id === 'payment_status' &&
    item.reason === 'live_tool_fact_overrides_memory'));
  assert.ok(context.dropped.some(item => item.id === 'refund_policy' &&
    item.reason === 'policy_evidence_overrides_procedural_memory'));
});

test('context budget includes reserves and reports dropped optional content', () => {
  const context = buildContext({ run, events: [], evidence: null, summary: null,
    messages: [{ id: 'recent', sequence: 1, role: 'user', content: 'x'.repeat(300), createdAt: now }],
    memories: [hit('database', 'project_decision', 'PostgreSQL')],
    budget: 256, outputReserve: 64, systemReserve: 64 });
  assert.ok(context.estimatedInputTokens + context.outputReserve + context.systemReserve <= context.budget);
  assert.ok(context.dropped.some(item => item.id === 'recent'));
});
