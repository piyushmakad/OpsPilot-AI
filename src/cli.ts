import { AgentEngine } from './engine.js';
import { DemoModel, HostedModel } from './model.js';
import type { AgentModel } from './model.js';
import { RunRepository } from './repository.js';
import { KnowledgeRepository } from './knowledge-repository.js';
import { BgeSmallEmbeddings } from './embedding.js';
import { KnowledgeSearch } from './retrieval.js';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { WorkflowStore, SCENARIOS, type Scenario, DEMO_TENANT } from './workflow-store.js';
import { createWorkflowRuntime } from './workflow-runtime.js';
import { serve } from './api.js';
import { MemoryRepository, type MemoryScope, type MemoryType } from './memory-repository.js';
import { ConversationRepository, type ConversationRole } from './conversation-repository.js';

const [command, ...args] = process.argv.slice(2);
const repository = RunRepository.fromEnvironment();

try {
  if (command === 'migrate') {
    await repository.migrate();
    console.log('Migration applied');
  } else if (command === 'seed-day3') {
    const store = new WorkflowStore(repository);
    await store.seed();
    const knowledge = KnowledgeRepository.fromEnvironment();
    try {
      await knowledge.ingest({ tenantId: DEMO_TENANT, documentKey: 'refund-policy', version: 1,
        title: 'Synthetic refund policy', source: 'synthetic-day3-refund-policy.md', status: 'ACTIVE',
        markdown: `# Synthetic refund policy\n\n## Eligibility\n\nA successful full USD payment may be refunded within 30 days of payment. An already refunded payment must not be refunded again. Payments over the configured automatic threshold require manager approval. Notify the customer only after confirmed refund success.`,
      });
    } finally { await knowledge.close(); }
    const search = KnowledgeSearch.fromEnvironment(new BgeSmallEmbeddings());
    try { console.log(JSON.stringify({ seeded: SCENARIOS, indexedChunks: await search.indexPending(DEMO_TENANT) })); }
    finally { await search.close(); }
  } else if (command === 'reset-day3') {
    await new WorkflowStore(repository).resetDemo();
    console.log('Synthetic Day 3 runs and payments reset. Run seed-day3 before the next demo.');
  } else if (command === 'serve') {
    await serve(repository);
  } else if (command === 'workflow') {
    const [action, ...rest] = args;
    const store = new WorkflowStore(repository);
    if (action === 'start') {
      const [scenario, ...words] = rest;
      if (!SCENARIOS.includes(scenario as Scenario)) throw new Error(`Scenario must be: ${SCENARIOS.join(', ')}`);
      const demo = words.includes('--demo');
      const goal = words.filter(w => w !== '--demo').join(' ') ||
        'Refund my latest payment and WhatsApp me when it is done.';
      const run = await store.create(goal, scenario as Scenario);
      const runtime = createWorkflowRuntime(repository, demo);
      try { await runtime.engine.execute(run.id); }
      finally { await runtime.knowledge.close(); }
      console.log(JSON.stringify({ run: await repository.get(run.id), events: await repository.events(run.id) }, null, 2));
    } else if (action === 'resume' && rest[0]) {
      const runtime = createWorkflowRuntime(repository, rest.includes('--demo'));
      try { console.log(await runtime.engine.execute(rest[0])); }
      finally { await runtime.knowledge.close(); }
      console.log(JSON.stringify(await repository.get(rest[0]), null, 2));
    } else if (action === 'tick') {
      const runtime = createWorkflowRuntime(repository, rest.includes('--demo'));
      try {
        await store.expireApprovals();
        for (const id of await store.dueRuns()) await runtime.engine.execute(id);
      }
      finally { await runtime.knowledge.close(); }
    } else if (action === 'approve' || action === 'reject') {
      if (!rest[0]) throw new Error('Approval ID required');
      console.log(await store.decideApproval(rest[0], action === 'approve' ? 'APPROVED' : 'REJECTED', 'local-manager'));
    } else if (action === 'approvals') {
      console.log(JSON.stringify(await store.approvals(), null, 2));
    } else if (action === 'show' && rest[0]) {
      console.log(JSON.stringify({ run: await repository.get(rest[0]), events: await repository.events(rest[0]) }, null, 2));
    } else throw new Error('Usage: workflow start <scenario> [--demo] [goal] | resume <id> [--demo] | tick [--demo] | approvals | approve <id> | reject <id> | show <id>');
  } else if (command === 'memory') {
    const [action, tenant, user, scopeType, rawScopeId, ...rest] = args;
    const memory = new MemoryRepository(repository.pool);
    if (!tenant || !user || !scopeType || !rawScopeId) throw new Error('Usage: memory put|list|history <tenant> <user> <global|project|conversation> <scope-id|- for global> ...');
    const scopeId = rawScopeId === '-' ? '' : rawScopeId;
    if (action === 'put') {
      const [type, key, ...words] = rest;
      if (!type || !key || !words.length) throw new Error('Usage: memory put <tenant> <user> <scope> <scope-id> <type> <key> <value>');
      console.log(JSON.stringify(await memory.put({ tenantId: tenant, userId: user,
        scopeType: scopeType as MemoryScope, scopeId, type: type as MemoryType,
        key, value: words.join(' ') }), null, 2));
    } else if (action === 'list' && rest.length === 0) {
      console.log(JSON.stringify(await memory.list(tenant, user, scopeType as MemoryScope, scopeId), null, 2));
    } else if (action === 'history' && rest.length === 1 && rest[0]) {
      console.log(JSON.stringify(await memory.history(tenant, user, scopeType as MemoryScope, scopeId, rest[0]), null, 2));
    } else throw new Error('Usage: memory put|list|history <tenant> <user> <scope> <scope-id> ...');
  } else if (command === 'conversation') {
    const [action, tenant, user, ...rest] = args;
    if (!tenant || !user) throw new Error('Usage: conversation create|add|show <tenant> <user> ...');
    const conversations = new ConversationRepository(repository.pool);
    if (action === 'create' && rest.length <= 1) {
      console.log(JSON.stringify({ conversationId: await conversations.create(tenant, user, rest[0]) }, null, 2));
    } else if (action === 'add' && rest.length >= 3 && rest[0] && rest[1]) {
      console.log(JSON.stringify(await conversations.append(tenant, user, rest[0],
        rest[1] as ConversationRole, rest.slice(2).join(' ')), null, 2));
    } else if (action === 'show' && rest.length === 1 && rest[0]) {
      console.log(JSON.stringify(await conversations.messages(tenant, user, rest[0]), null, 2));
    } else throw new Error('Usage: conversation create <tenant> <user> [project] | add <tenant> <user> <id> <role> <message> | show <tenant> <user> <id>');
  } else if (command === 'ingest') {
    const [tenantId, documentKey, versionText, path, ...flags] = args;
    const version = Number(versionText);
    if (!tenantId || !documentKey || !path || !Number.isSafeInteger(version) || version < 1 ||
        flags.some(flag => flag !== '--deprecated')) {
      throw new Error('Usage: ingest <tenant> <document-key> <version> <markdown-path> [--deprecated]');
    }
    const markdown = await readFile(path, 'utf8');
    const title = /^#\s+(.+)$/m.exec(markdown)?.[1]?.trim() || basename(path);
    const knowledge = KnowledgeRepository.fromEnvironment();
    try {
      const result = await knowledge.ingest({
        tenantId, documentKey, version, title, source: path,
        status: flags.includes('--deprecated') ? 'DEPRECATED' : 'ACTIVE', markdown,
      });
      console.log(JSON.stringify(result, null, 2));
    } finally { await knowledge.close(); }
  } else if (command === 'index') {
    if (args.length !== 1 || !args[0]) throw new Error('Usage: index <tenant>');
    const search = KnowledgeSearch.fromEnvironment(new BgeSmallEmbeddings());
    try {
      const chunks = await search.indexPending(args[0]);
      console.log(JSON.stringify({ tenantId: args[0], embeddedChunks: chunks }, null, 2));
    } finally { await search.close(); }
  } else if (command === 'search') {
    const [tenantId, ...queryParts] = args;
    const query = queryParts.join(' ');
    if (!tenantId || !query) throw new Error('Usage: search <tenant> <query>');
    const search = KnowledgeSearch.fromEnvironment(new BgeSmallEmbeddings());
    try {
      const candidates = await search.search(tenantId, query, {
        candidateCount: process.env.RAG_CANDIDATES ? Number(process.env.RAG_CANDIDATES) : undefined,
        topK: process.env.RAG_TOP_K ? Number(process.env.RAG_TOP_K) : undefined,
        minSemanticSimilarity: process.env.RAG_MIN_SEMANTIC ? Number(process.env.RAG_MIN_SEMANTIC) : undefined,
        minLexicalRank: process.env.RAG_MIN_LEXICAL ? Number(process.env.RAG_MIN_LEXICAL) : undefined,
      });
      console.log(JSON.stringify(candidates.length
        ? { status: 'evidence_found', candidates }
        : { status: 'insufficient_evidence', candidates: [] }, null, 2));
    } finally { await search.close(); }
  } else if (command === 'start') {
    const { demo, rag, tenantId, request } = parseStartArgs(args);
    const run = await repository.create(request, tenantId, rag);
    console.log(`Created run ${run.id}`);
    await executeRun(run.id, demo ? new DemoModel() : new HostedModel());
    console.log(JSON.stringify(await repository.get(run.id), null, 2));
  } else if (command === 'resume' && args[0]) {
    const demo = args.includes('--demo');
    await executeRun(args[0], demo ? new DemoModel() : new HostedModel());
    console.log(JSON.stringify(await repository.get(args[0]), null, 2));
  } else if (command === 'show' && args[0]) {
    console.log(JSON.stringify({ run: await repository.get(args[0]), events: await repository.events(args[0]) }, null, 2));
  } else {
    throw new Error('Usage: migrate | memory ... | conversation ... | seed-day3 | reset-day3 | serve | workflow ... | ingest <tenant> <key> <version> <path> [--deprecated] | index <tenant> | search <tenant> <query> | start [--rag] [--tenant ID] [--demo] "request" | resume <run-id> [--demo] | show <run-id>');
  }
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await repository.close();
}

async function executeRun(runId: string, model: AgentModel): Promise<void> {
  const run = await repository.get(runId);
  if (!run) throw new Error('Run not found');
  const knowledge = run.ragEnabled ? KnowledgeSearch.fromEnvironment(new BgeSmallEmbeddings()) : undefined;
  try {
    await new AgentEngine(repository, model, knowledge).execute(runId);
  } finally { await knowledge?.close(); }
}

function parseStartArgs(values: string[]): { demo: boolean; rag: boolean; tenantId: string; request: string } {
  let demo = false;
  let rag = false;
  let tenantId = 'demo';
  const words: string[] = [];
  for (let index = 0; index < values.length; index++) {
    const value = values[index];
    if (value === '--demo') demo = true;
    else if (value === '--rag') rag = true;
    else if (value === '--tenant') {
      const next = values[++index];
      if (!next || next.startsWith('--')) throw new Error('--tenant requires an ID');
      tenantId = next;
    } else if (value) words.push(value);
  }
  return { demo, rag, tenantId, request: words.join(' ') };
}
