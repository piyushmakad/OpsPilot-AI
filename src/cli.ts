import { AgentEngine } from './engine.js';
import { DemoModel, HostedModel } from './model.js';
import type { AgentModel } from './model.js';
import { RunRepository } from './repository.js';
import { KnowledgeRepository } from './knowledge-repository.js';
import { BgeSmallEmbeddings } from './embedding.js';
import { KnowledgeSearch } from './retrieval.js';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

const [command, ...args] = process.argv.slice(2);
const repository = RunRepository.fromEnvironment();

try {
  if (command === 'migrate') {
    await repository.migrate();
    console.log('Migration applied');
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
    throw new Error('Usage: migrate | ingest <tenant> <key> <version> <path> [--deprecated] | index <tenant> | search <tenant> <query> | start [--rag] [--tenant ID] [--demo] "request" | resume <run-id> [--demo] | show <run-id>');
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
