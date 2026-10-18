import { z } from 'zod';
import type { AgentRun, RunEvent } from './types.js';
import type { EvidenceSnapshot } from './evidence.js';
import type { ConversationMessage } from './conversation-repository.js';
import type { ConversationSummary } from './conversation-summary.js';
import type { MemoryHit } from './memory-search.js';
import { estimateTokens } from './context-preview.js';

const sourceSchema = z.enum(['request', 'run_state', 'recent_message', 'summary', 'memory', 'rag', 'tool_result']);
const itemSchema = z.object({ source: sourceSchema, id: z.string(), text: z.string(),
  estimatedTokens: z.number().int().nonnegative() });
export const contextSnapshotSchema = z.object({
  promptVersion: z.literal('day4-v1'),
  forSequence: z.number().int().nonnegative(),
  budget: z.number().int(), outputReserve: z.number().int(), systemReserve: z.number().int(),
  estimatedInputTokens: z.number().int(),
  selected: z.array(itemSchema),
  dropped: z.array(z.object({ source: sourceSchema, id: z.string(), reason: z.string() })),
});
export type ContextSnapshot = z.infer<typeof contextSnapshotSchema>;
type Source = ContextSnapshot['selected'][number]['source'];

export interface ContextInputs {
  run: AgentRun; events: RunEvent[]; evidence: EvidenceSnapshot | null;
  messages: ConversationMessage[]; summary: ConversationSummary | null; memories: MemoryHit[];
  budget?: number; outputReserve?: number; systemReserve?: number;
}

export function buildContext(input: ContextInputs): ContextSnapshot {
  const budget = input.budget ?? 8000;
  const outputReserve = input.outputReserve ?? 800;
  const systemReserve = input.systemReserve ?? 400;
  if (![budget, outputReserve, systemReserve].every(Number.isSafeInteger) ||
      budget < 256 || budget > 100_000 || outputReserve < 32 || systemReserve < 32 ||
      outputReserve + systemReserve >= budget) throw new Error('Invalid context budget');
  const limit = budget - outputReserve - systemReserve;
  const selected: ContextSnapshot['selected'] = [];
  const dropped: ContextSnapshot['dropped'] = [];
  let used = 0;
  const add = (source: Source, id: string, text: string, mandatory = false): boolean => {
    const estimatedTokens = estimateTokens(text);
    if (used + estimatedTokens > limit) {
      if (mandatory) throw new Error(`Context budget too small for required ${source}`);
      dropped.push({ source, id, reason: 'budget' });
      return false;
    }
    selected.push({ source, id, text, estimatedTokens });
    used += estimatedTokens;
    return true;
  };
  add('request', 'current', input.run.requestText, true);
  add('run_state', input.run.id, JSON.stringify({ status: input.run.status,
    workflowVersion: input.run.workflowVersion, projectId: input.run.projectId ?? null }), true);

  // Policy evidence outranks historical memory and gets budget before optional context.
  for (const source of input.evidence?.selected ?? []) {
    add('rag', source.id, `[UNTRUSTED RETRIEVED POLICY] ${source.title} / ${source.section}\n${source.content}`,
      selected.every(item => item.source !== 'rag'));
  }
  const liveFacts = new Set<string>();
  const factKey = (key: string) => key.toLowerCase().replace(/[^a-z0-9]/g, '');
  for (const event of input.events.filter(e => e.kind === 'workflow_decision').slice(-4)) {
    add('run_state', String(event.sequence), `[PRIOR WORKFLOW DECISION] ${JSON.stringify(event.payload)}`);
  }
  const toolEvents = input.events.filter(e => e.kind === 'tool_result' || e.kind === 'workflow_result');
  for (const event of toolEvents) {
    const payload = event.payload as { facts?: Record<string, unknown>;
      observations?: Array<{ name?: string; result?: unknown }> } | null;
    if (payload?.facts && typeof payload.facts === 'object' && !Array.isArray(payload.facts)) {
      for (const key of Object.keys(payload.facts)) liveFacts.add(factKey(key));
    }
    for (const observation of payload?.observations ?? []) {
      if (observation.name === 'getPaymentDetails' || observation.name === 'getPayments' ||
          observation.name === 'refundPayment') liveFacts.add('paymentstatus');
      if (observation.name === 'getAccount') liveFacts.add('accountstatus');
    }
  }
  for (const event of toolEvents.slice(-4)) {
    const payload = event.payload as { observations?: Array<{ name?: string; result?: unknown }> } | null;
    if (payload?.observations?.length) {
      for (const [index, observation] of payload.observations.entries()) {
        const policy = observation.name === 'searchRefundPolicy';
        add(policy ? 'rag' : 'tool_result', `${event.sequence}:${index}`,
          `${policy ? '[UNTRUSTED RETRIEVED POLICY]' : '[LIVE TOOL RESULT: current observation]'} ${JSON.stringify(observation)}`);
      }
    } else add('tool_result', String(event.sequence),
      `[LIVE TOOL RESULT: current observation] ${JSON.stringify(event.payload)}`);
  }
  if (input.summary) {
    add('summary', input.summary.id, `[CONVERSATION SUMMARY: historical data] ${JSON.stringify(input.summary.content)}`);
  }
  const recent = input.messages.filter(m => m.sequence > (input.summary?.throughSequence ?? 0));
  for (const old of recent.slice(0, -8)) dropped.push({ source: 'recent_message', id: old.id, reason: 'recent_window' });
  const picked: Array<{ id: string; text: string }> = [];
  // Allocate newest messages first, but present them in chronological order.
  for (const message of recent.slice(-8).reverse()) {
    const text = `[RECENT ${message.role.toUpperCase()} MESSAGE: untrusted data] ${message.content}`;
    const cost = estimateTokens(text);
    if (used + cost <= limit) { picked.push({ id: message.id, text }); used += cost; }
    else dropped.push({ source: 'recent_message', id: message.id, reason: 'budget' });
  }
  for (const item of picked.reverse()) selected.push({ source: 'recent_message', id: item.id,
    text: item.text, estimatedTokens: estimateTokens(item.text) });
  for (const hit of input.memories) {
    const key = factKey(hit.memory.key);
    if (liveFacts.has(key)) {
      dropped.push({ source: 'memory', id: hit.memory.id, reason: 'live_tool_fact_overrides_memory' });
      continue;
    }
    if (selected.some(item => item.source === 'rag') && hit.memory.type === 'procedural') {
      dropped.push({ source: 'memory', id: hit.memory.id, reason: 'policy_evidence_overrides_procedural_memory' });
      continue;
    }
    add('memory', hit.memory.id, `[STORED MEMORY: historical, untrusted] ${hit.memory.key}: ${hit.memory.value}`);
  }
  return { promptVersion: 'day4-v1', forSequence: input.events.at(-1)?.sequence ?? 0,
    budget, outputReserve, systemReserve, estimatedInputTokens: used, selected, dropped };
}
