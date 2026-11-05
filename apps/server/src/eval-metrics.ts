// Pure scoring functions for the Day 5 evaluation harness. No database or model calls here,
// so every metric can be unit tested against hand-computed values.

export type Label = readonly [documentKey: string, section: string];
export type RankedHit = { documentKey: string; section: string };

export type RetrievalCaseScore = {
  answerable: boolean;
  abstained: boolean;
  hitAt1: number;
  hitAtK: number;
  recallAtK: number;
  reciprocalRank: number;
};

export type MetricGroup = { n: number; hitAt1: number; hitAtK: number; recallAtK: number; mrr: number };

export type RetrievalSummary = MetricGroup & {
  falseAbstentionRate: number;
  noAnswerCases: number;
  correctAbstentionRate: number;
  leaks: number;
  byCategory: Record<string, MetricGroup>;
  latencyMs: { p50: number; p95: number };
};

const same = (hit: RankedHit, label: Label) =>
  hit.documentKey === label[0] && hit.section.toLowerCase() === label[1].toLowerCase();

// 1-based rank of the first hit matching each label, or null when it never appears in the list.
export function labelRanks(hits: RankedHit[], relevant: readonly Label[]): Array<number | null> {
  return relevant.map(label => {
    const index = hits.findIndex(hit => same(hit, label));
    return index === -1 ? null : index + 1;
  });
}

export function scoreRetrievalCase(hits: RankedHit[], relevant: readonly Label[], k: number): RetrievalCaseScore {
  if (!Number.isInteger(k) || k < 1) throw new Error('k must be a positive integer');
  const abstained = hits.length === 0;
  if (!relevant.length) {
    return { answerable: false, abstained, hitAt1: 0, hitAtK: 0, recallAtK: 0, reciprocalRank: 0 };
  }
  const ranks = labelRanks(hits, relevant);
  const found = ranks.filter((rank): rank is number => rank !== null && rank <= k);
  const best = found.length ? Math.min(...found) : null;
  return {
    answerable: true, abstained,
    hitAt1: best === 1 ? 1 : 0,
    hitAtK: best !== null ? 1 : 0,
    recallAtK: found.length / relevant.length,
    reciprocalRank: best !== null ? 1 / best : 0,
  };
}

const mean = (values: number[]) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;

export function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index]!;
}

function group(scores: RetrievalCaseScore[]): MetricGroup {
  return {
    n: scores.length,
    hitAt1: mean(scores.map(s => s.hitAt1)),
    hitAtK: mean(scores.map(s => s.hitAtK)),
    recallAtK: mean(scores.map(s => s.recallAtK)),
    mrr: mean(scores.map(s => s.reciprocalRank)),
  };
}

export function summarizeRetrieval(cases: Array<{ category: string; score: RetrievalCaseScore;
  latencyMs: number; leaks: number }>): RetrievalSummary {
  const answerable = cases.filter(c => c.score.answerable);
  const noAnswer = cases.filter(c => !c.score.answerable);
  const byCategory: Record<string, MetricGroup> = {};
  for (const category of new Set(answerable.map(c => c.category))) {
    byCategory[category] = group(answerable.filter(c => c.category === category).map(c => c.score));
  }
  const latencies = cases.map(c => c.latencyMs);
  return {
    ...group(answerable.map(c => c.score)),
    falseAbstentionRate: mean(answerable.map(c => c.score.abstained ? 1 : 0)),
    noAnswerCases: noAnswer.length,
    correctAbstentionRate: mean(noAnswer.map(c => c.score.abstained ? 1 : 0)),
    leaks: cases.reduce((total, c) => total + c.leaks, 0),
    byCategory,
    latencyMs: { p50: percentile(latencies, 50), p95: percentile(latencies, 95) },
  };
}

// Higher is better for every gated metric. Leaks are a hard gate: any leak is a regression.
export const GATED_METRICS = ['hitAt1', 'hitAtK', 'recallAtK', 'mrr', 'correctAbstentionRate'] as const;

export function compareToBaseline(current: RetrievalSummary, baseline: Partial<RetrievalSummary>,
  tolerance = 0.03): string[] {
  const regressions: string[] = [];
  for (const metric of GATED_METRICS) {
    const before = baseline[metric];
    if (typeof before === 'number' && current[metric] < before - tolerance) {
      regressions.push(`${metric} fell from ${before.toFixed(3)} to ${current[metric].toFixed(3)}`);
    }
  }
  if (current.leaks > 0) regressions.push(`${current.leaks} deprecated or cross-tenant chunk(s) returned`);
  return regressions;
}

// Patterns are case-insensitive substrings; "a|b" passes when either alternative appears.
export function matchesPattern(text: string, pattern: string): boolean {
  const haystack = text.toLowerCase();
  return pattern.split('|').some(option => option.trim() && haystack.includes(option.trim().toLowerCase()));
}
