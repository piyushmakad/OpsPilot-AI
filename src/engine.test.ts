import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentEngine } from './engine.js';
import { DemoModel, type AgentModel } from './model.js';
import { RunRepository } from './repository.js';
import type { KnowledgeSearch, SearchCandidate } from './retrieval.js';
import { selectEvidence } from './evidence.js';
import { buildContext } from './context-builder.js';
import type { ContextService } from './context-service.js';
import type { AgentRun, RunEvent } from './types.js';

const now = new Date();
const candidate: SearchCandidate = {
  chunkId: 'chunk-1', documentId: 'document-1', documentKey: 'infra-guide',
  version: 1, title: 'Infra guide', section: 'Ingress', source: 'local.md',
  content: 'The NLB sends traffic to ingress-nginx, which routes to Services.',
  semanticScore: 0.7, lexicalScore: 0.2, rankScore: 0.03,
};

class MemoryRuns {
  run: AgentRun;
  entries: RunEvent[] = [];

  constructor(ragEnabled: boolean) {
    this.run = {
      id: 'run-1', tenantId: 'demo', requestText: 'How does ingress work?', ragEnabled,
      status: 'pending', outputText: null, errorText: null, leaseToken: null,
      leaseExpiresAt: null, workflowVersion: ragEnabled ? 2 : 1,
      actorId: null, scenario: null, nextActionAt: null,
      createdAt: now, updatedAt: now,
    };
  }

  async get(): Promise<AgentRun> { return this.run; }
  async claim(): Promise<string> { this.run.status = 'running'; return 'lease'; }
  async events(): Promise<RunEvent[]> { return this.entries; }
  async append(_id: string, _token: string, kind: RunEvent['kind'], payload: unknown): Promise<void> {
    this.entries.push({ runId: this.run.id, sequence: this.entries.length + 1, kind, payload, createdAt: now });
  }
  async finish(_id: string, _token: string, status: 'completed' | 'failed', text: string): Promise<void> {
    this.run.status = status;
    if (status === 'completed') this.run.outputText = text;
    else this.run.errorText = text;
  }

  repository(): RunRepository { return this as unknown as RunRepository; }
}

const knowledge = (hits: SearchCandidate[]) => ({
  async warmup() {},
  async search() { return hits; },
}) as Pick<KnowledgeSearch, 'warmup' | 'search'>;

test('abstains without policy evidence and never calls the model', async () => {
  const runs = new MemoryRuns(true);
  let calls = 0;
  const model: AgentModel = { async decide() { calls++; throw new Error('should not be called'); } };
  await new AgentEngine(runs.repository(), model, knowledge([])).execute('run-1');
  assert.equal(calls, 0);
  assert.equal(runs.run.status, 'completed');
  assert.match(runs.run.outputText!, /not have enough relevant knowledge/);
  assert.equal(runs.entries[0]?.kind, 'retrieval');
});

test('sends selected evidence to the model and preserves a source citation', async () => {
  const runs = new MemoryRuns(true);
  const model: AgentModel = {
    async decide(_request, _events, evidence) {
      assert.equal(evidence?.selected[0]?.content, candidate.content);
      return { kind: 'final', text: 'Traffic passes through the NLB [S1].',
        outcome: 'answered', citations: ['S1'] };
    },
  };
  await new AgentEngine(runs.repository(), model, knowledge([candidate])).execute('run-1');
  assert.equal(runs.run.status, 'completed');
  assert.match(runs.run.outputText!, /Sources:\n\[S1\] Infra guide/);
  assert.deepEqual(runs.entries.map(event => event.kind), ['retrieval', 'decision']);
});

test('resumes from persisted retrieval without searching again', async () => {
  const runs = new MemoryRuns(true);
  await runs.append('', '', 'retrieval', selectEvidence(runs.run.requestText, 'demo', [candidate]));
  const neverSearch = {
    async warmup() {}, async search() { throw new Error('retrieval repeated'); },
  } as Pick<KnowledgeSearch, 'warmup' | 'search'>;
  const model: AgentModel = { async decide() {
    return { kind: 'final', text: 'Ingress routes traffic [S1].', outcome: 'answered', citations: ['S1'] };
  } };
  await new AgentEngine(runs.repository(), model, neverSearch).execute('run-1');
  assert.equal(runs.run.status, 'completed');
});

test('rejects invented citation IDs', async () => {
  const runs = new MemoryRuns(true);
  const model: AgentModel = { async decide() {
    return { kind: 'final', text: 'Unsupported claim.', outcome: 'answered', citations: ['S9'] };
  } };
  await assert.rejects(new AgentEngine(runs.repository(), model, knowledge([candidate])).execute('run-1'),
    /unknown evidence source/);
  assert.equal(runs.run.status, 'failed');
});

test('preserves the Day 1 demo tool path', async () => {
  const runs = new MemoryRuns(false);
  runs.run.requestText = 'What is the refund policy?';
  await new AgentEngine(runs.repository(), new DemoModel()).execute('run-1');
  assert.equal(runs.run.status, 'completed');
  assert.deepEqual(runs.entries.map(event => event.kind), ['decision', 'tool_result', 'decision']);
});

test('persists selected context before model call and reuses it after a restart', async () => {
  const runs = new MemoryRuns(true);
  const snapshot = selectEvidence(runs.run.requestText, 'demo', [candidate]);
  await runs.append('', '', 'retrieval', snapshot);
  const context = buildContext({ run: runs.run, events: runs.entries, evidence: snapshot,
    messages: [], summary: null, memories: [] });
  await runs.append('', '', 'context', context);
  const service = { warmup: async () => {}, build: async () => {
    throw new Error('Context should be reused');
  } } as Pick<ContextService, 'build' | 'warmup'>;
  const model: AgentModel = { async decide(_request, _events, visible, selected) {
    assert.equal(selected?.promptVersion, 'day4-v1');
    assert.equal(visible?.selected[0]?.id, 'S1');
    return { kind: 'final', text: 'Ingress routes traffic [S1].',
      outcome: 'answered', citations: ['S1'] };
  } };
  await new AgentEngine(runs.repository(), model, knowledge([]), service).execute('run-1');
  assert.deepEqual(runs.entries.map(event => event.kind), ['retrieval', 'context', 'decision']);
  assert.equal(runs.run.status, 'completed');
});
