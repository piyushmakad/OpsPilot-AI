import { z } from 'zod';
import type { SearchCandidate } from './retrieval.js';
import type { Decision } from './types.js';

const sourceSchema = z.object({
  id: z.string(), chunkId: z.string(), documentId: z.string(),
  documentKey: z.string(), version: z.number().int(),
  title: z.string(), section: z.string(), source: z.string(), content: z.string(),
});

export const evidenceSnapshotSchema = z.object({
  query: z.string(), tenantId: z.string(),
  status: z.enum(['evidence_found', 'insufficient_evidence']),
  candidates: z.array(z.object({
    chunkId: z.string(), documentKey: z.string(), section: z.string(),
    semanticScore: z.number().nullable(), lexicalScore: z.number().nullable(), rankScore: z.number(),
  })),
  selected: z.array(sourceSchema),
});

export type EvidenceSnapshot = z.infer<typeof evidenceSnapshotSchema>;

export function selectEvidence(
  query: string, tenantId: string, candidates: SearchCandidate[],
  maxChars = 3600, maxChunks = 4,
): EvidenceSnapshot {
  if (!Number.isInteger(maxChars) || maxChars < 200 || !Number.isInteger(maxChunks) || maxChunks < 1) {
    throw new Error('Invalid evidence budget');
  }
  const selected: EvidenceSnapshot['selected'] = [];
  const seen = new Set<string>();
  let used = 0;
  const add = (candidate: SearchCandidate) => {
    if (selected.length >= maxChunks || used + candidate.content.length > maxChars ||
        selected.some(item => item.chunkId === candidate.chunkId)) return;
    selected.push({
      id: `S${selected.length + 1}`, chunkId: candidate.chunkId,
      documentId: candidate.documentId, documentKey: candidate.documentKey,
      version: candidate.version, title: candidate.title, section: candidate.section,
      source: candidate.source, content: candidate.content,
    });
    used += candidate.content.length;
  };
  // First cover distinct sections; adjacent chunks can be added if budget remains.
  for (const candidate of candidates) {
    const key = `${candidate.documentId}:${candidate.section}`;
    if (seen.has(key)) continue;
    seen.add(key);
    add(candidate);
  }
  for (const candidate of candidates) add(candidate);
  return {
    query, tenantId,
    status: selected.length ? 'evidence_found' : 'insufficient_evidence',
    candidates: candidates.map(candidate => ({
      chunkId: candidate.chunkId, documentKey: candidate.documentKey,
      section: candidate.section, semanticScore: candidate.semanticScore,
      lexicalScore: candidate.lexicalScore, rankScore: candidate.rankScore,
    })),
    selected,
  };
}

export function formatGroundedFinal(
  decision: Extract<Decision, { kind: 'final' }>, snapshot: EvidenceSnapshot,
): string {
  if (!decision.outcome) throw new Error('Grounded final decision requires an outcome');
  const citations = [...new Set(decision.citations ?? [])];
  const sources = citations.map(id => snapshot.selected.find(source => source.id === id));
  if (sources.some(source => !source)) throw new Error('Model cited an unknown evidence source');
  const inlineIds = [...decision.text.matchAll(/\[S\d+\]/g)].map(match => match[0].slice(1, -1));
  if (inlineIds.some(id => !citations.includes(id))) {
    throw new Error('Model used an unlisted inline citation');
  }
  if (decision.outcome === 'answered' && citations.length === 0) {
    throw new Error('Grounded answer requires at least one citation');
  }
  if (decision.outcome === 'insufficient_policy') {
    return 'I do not have enough reliable knowledge to answer this request.';
  }
  const sourceLines = sources.map(source =>
    `[${source!.id}] ${source!.title} — ${source!.section} (v${source!.version})`);
  if (decision.outcome === 'conflicting_policy') {
    const message = 'The retrieved sources appear to conflict. I cannot give a reliable answer without review.';
    return sourceLines.length ? `${message}\n\nSources:\n${sourceLines.join('\n')}` : message;
  }
  if (decision.outcome === 'missing_live_facts' && citations.length === 0) {
    return 'I cannot determine this without current customer or account facts. No live customer system is connected yet.';
  }
  return sourceLines.length
    ? `${decision.text.trim()}\n\nSources:\n${sourceLines.join('\n')}`
    : decision.text.trim();
}
