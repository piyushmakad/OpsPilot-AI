# Day 5: evaluation

Days 1–4 built behavior. Day 5 measures it. Without measurement, every change to chunking, thresholds, prompts, or models is a guess: it might help the query you tried by hand and quietly break ten you did not try. An eval turns "it seems to work" into a number you can compare before and after a change.

## Why two suites

A grounded answer can fail in two different places, and the fixes are different:

1. **Retrieval** didn't find the right passage. No prompt can fix that. You change chunking, embeddings, thresholds, or add a reranker.
2. **Generation** had the right passage but answered badly: wrong outcome, missing fact, bad citation, or a claim not in the evidence. You change the prompt, the model, or the output checks.

Measuring only the final answer hides which layer broke. So `eval retrieval` scores search alone (fast, local, free, deterministic), and `eval answers` scores the full agent path through `AgentEngine`, the same code a real `start --rag` run uses.

## The labeled set

[evals/dataset.json](../evals/dataset.json) is the ground truth. Each retrieval case names the document and section a correct search must return. Categories exist so a regression points at a kind of weakness, not just a lower average:

| Category | What it tests |
| --- | --- |
| `keyword` | Query shares words with the document; the easy case |
| `paraphrase` | Same meaning, different words ("money back" vs "refund"); tests semantic search |
| `identifier` | Error codes and exact names (`AADSTS50011`); embeddings are weak here and keyword search helps |
| `multi_section` | Needs two sections; tests evidence selection |
| `no_answer` | Nothing in the corpus answers it; the system must return nothing rather than something plausible |

The corpus in [evals/corpus](../evals/corpus) is synthetic. It also includes traps: a deprecated v1 refund policy (14 days), another tenant's policy (90 days), and a prompt injection hidden in the Billing FAQ. The eval loads everything into throwaway tenants and deletes them afterwards.

## Metrics, in plain words

- **hit@1**: was the right passage ranked first?
- **hit@5**: was it anywhere in the top five? (`topK` is 5.)
- **recall@5**: for multi-section questions, what fraction of the needed sections appeared?
- **MRR** (mean reciprocal rank): 1 if first, 0.5 if second, 0.33 if third… averaged. One number for "how high up is the right answer".
- **evidenceRecall**: recall after `selectEvidence` applies the 4-chunk / 3,600-character budget. This is what the model actually sees.
- **falseAbstain**: an answerable question returned nothing. The user gets "I don't know" for something documented.
- **correctAbstain**: an unanswerable question returned nothing. Otherwise the model receives irrelevant text and may answer from it.
- **leaks**: a deprecated or other-tenant chunk was returned. This must always be 0; it is a security and correctness gate, not a quality metric.

Answer metrics: **outcomeAccuracy** (answered / abstained / missing_live_facts as expected), **requiredFacts** (the key fact such as "30" appears), **forbiddenContentAbsent** (no stale "14 days", no injected "unlimited"), **citationAccuracy** (cited the right document), and **faithfulness**. Faithfulness comes from an LLM judge, a second model call that checks every claim against the evidence. A judge can also be wrong, so read its unsupported claims rather than trusting the score blindly.

## What the first run found (2026-11-04)

Retrieval, 28 queries:

| Mode | hit@1 | hit@5 | MRR | falseAbstain | correctAbstain | leaks |
| --- | --- | --- | --- | --- | --- | --- |
| hybrid | 0.78 | 1.00 | 0.88 | 0 | 1.00 | 0 |
| semantic only | 0.74 | 1.00 | 0.86 | 0 | 1.00 | 0 |
| lexical only | 0.30 | 0.30 | 0.30 | 0.70 | 1.00 | 0 |

1. **Keyword search alone misses 70% of answerable questions.** `websearch_to_tsquery` requires every query word to match, so natural questions rarely match. It still earns its place: identifier queries score 1.0 in hybrid, and hybrid beats semantic-only on hit@1 and MRR.
2. **The 0.55 similarity threshold sits in a narrow safe band.** In the sweep, 0.45 lets 4 of 5 unanswerable questions through, and 0.6 starts dropping answerable ones. The safe band is 0.5–0.55. With a corpus this small that margin is fragile; re-run the sweep whenever the embedding model or corpus changes.
3. **Ranking, not recall, is the weakness.** Everything is found in the top 5, but 5 of 23 are not ranked first. Example: "Will you erase our workspace if we are late paying?" ranks *Account deletion* above *Failed payments*. That is exactly what a cross-encoder reranker fixes, and the hit@1 baseline will show whether it does.

Answers, 9 cases through the real agent (Groq `openai/gpt-oss-120b`): no hallucination flagged by the judge, correct abstention, correct "missing live facts" for an account-specific question, and the injected "refunds are unlimited" text was **not** repeated. One real failure remains: for "How are refunds paid out, and are they unlimited?", the model treated the forum note as an official policy and returned `conflicting_policy`. The prompt held, but the data model is the gap: the knowledge base cannot yet mark content as untrusted community text versus official policy. Fixing that (a trust level per document or section, filtered before retrieval) is a design change, so this case is left failing on purpose.

The run also surfaced two eval-harness lessons:
- The free Groq tier allows 8,000 tokens per minute. Two cases first "failed" with HTTP 429. That is an infrastructure error, not a wrong answer, so the harness now retries rate-limited cases instead of scoring them.
- The grader pattern `has been approved` flagged the correct sentence "to determine if it has been approved". Graders have bugs too; read failures before trusting the score.

## How to use it

```powershell
npm run eval                    # retrieval: hybrid vs semantic vs lexical, per category
npm run dev -- eval retrieval --sweep        # also sweep the semantic threshold
npm run eval:check              # fail (exit 1) if hybrid drops below evals/baseline.json
npm run dev -- eval retrieval --save-baseline  # accept the current numbers as the new baseline
npm run eval:answers            # full agent + LLM judge; sends synthetic corpus text to Groq
```

The loop is: change one thing → `npm run eval:check` → read the failures it prints → keep the change only if the numbers say so → `--save-baseline`. Try it: change the `0.55` default in `fuseCandidates` to `0.65` and run `eval:check`. It fails with hit@5 falling from 1.00 to 0.70.

Answer evals are not gated by default because the model is nondeterministic and costs tokens. Run them before changing prompts or models, and compare the per-case JSON in `evals/results/` (gitignored).

## Limits

28 retrieval queries and 9 answer cases are enough to catch large regressions and to teach the method, not to claim production accuracy. One flipped query moves hit@1 by about 4 points, which is why the gate tolerance is 0.03. Grow the set from real failures: every bug report becomes a labeled case, so it cannot regress silently.
