# OpsPilot AI

One evolving full stack AI engineering project. Day 1 provides a bounded agent execution loop and PostgreSQL-backed `AgentRun` state. Day 2 adds tenant-aware Markdown ingestion, hybrid retrieval, and grounded agent runs with citations.

## Why this design

- `agent_runs` records what has actually happened in a workflow. A future conversation can contain many runs.
- `agent_run_events` preserves model decisions and tool results. After a crash, the engine examines the last durable event before taking another step.
- Grounded runs also persist the retrieval query, candidate scores, and selected evidence before calling the model. A resumed run reuses that evidence snapshot.
- A PostgreSQL lease allows one worker to claim a run. Another worker can resume it after the lease expires.
- Model output is validated before any tool runs. The only current tool reads illustrative policy data. Write tools need approval, idempotency, and reconciliation before they are added.
- Five model decisions is the current loop bound. The live model call has a 30-second timeout.

```mermaid
flowchart LR
  A[Create AgentRun] --> B[Claim run]
  B --> C[Read durable events]
  C --> D{Last event}
  D -->|Pending tool decision| E[Run validated read-only tool]
  E --> F[Persist tool result]
  F --> C
  D -->|Grounded run| R[Retrieve and persist selected evidence]
  R --> G[Ask model with evidence]
  D -->|Day 1 run| G
  G --> H[Persist decision]
  H --> C
  D -->|Final decision| I[Complete run]
```

## Setup

Requires Node.js 20+, PostgreSQL, and an `opspilot` database. Install packages with `npm install` and run `npm run typecheck`.

Day 2 additionally requires the PostgreSQL `vector` extension to be installed on the server. `migrate` enables it in the database and creates the knowledge tables. The application database role needs permission to create the extension, or an administrator must enable it first.

In PowerShell:

```powershell
$env:DATABASE_URL = 'postgres://postgres:YOUR_PASSWORD@localhost:5432/opspilot'
npm run dev -- migrate
npm run dev -- start --demo 'What is the refund policy?'
npm run dev -- show RUN_ID
```

To ingest a Markdown policy after migrating:

```powershell
npm run dev -- ingest acme refund-enterprise 1 .\path\to\old-policy.md --deprecated
npm run dev -- ingest acme refund-enterprise 2 .\path\to\refund-enterprise.md
```

Use a positive version number for every document; mark older policies with `--deprecated`. The first `# Heading` supplies the title, and section headings guide chunking. Ingestion is transactional and re-ingesting the same tenant, key, and version replaces its chunks. Activating a newer version deprecates older active versions of the same key. Each chunk records its document, section, and source through its parent record.

## Day 2 retrieval experiment

Run these commands yourself after setting `DATABASE_URL` in the current shell:

```powershell
npm run dev -- migrate
npm run dev -- ingest demo operations-guide 1 'C:\path\to\your-guide.md'
npm run dev -- index demo
npm run dev -- search demo 'How did we diagnose the Postgres disk outage?'
```

`index` downloads `Xenova/bge-small-en-v1.5` on first use and computes embeddings locally. The model is 384-dimensional and the indexer stores its name with each vector. Search combines exact cosine search in pgvector with PostgreSQL full-text search using reciprocal rank fusion. Every database branch filters for the requested tenant and `ACTIVE` documents before ranking. The result includes chunk, document, section, source, version, and scores so you can inspect why a hit appeared. `insufficient_evidence` means no candidate passed the configured filters; it is not a calibrated probability of correctness.

Set `RAG_CANDIDATES`, `RAG_TOP_K`, `RAG_MIN_SEMANTIC`, or `RAG_MIN_LEXICAL` in the shell to experiment with ranking. Default values are 15, 5, 0.55 cosine similarity, and 0.01 lexical rank. These are starting values, not validated thresholds; use labeled queries before relying on them. Keep private source documents outside this repository.

## Ask the agent using retrieved evidence

After migrating and indexing, run a grounded request with the same tenant ID used at ingestion:

```powershell
npm run dev -- start --rag --tenant demo 'How did requests reach the application pods?'
```

This command sends the question and **up to four selected document excerpts** (3,600 characters of chunk text total) to the configured Groq model. The local file path, other candidates, and the entire document are not included in the model input. Do not use `--rag` with documents you do not want sent to that model. To inspect retrieval without a hosted call, use `search`, or use `start --rag --demo` for a deterministic evidence-path test.

The agent stores a `retrieval` event before the model call. `show RUN_ID` displays the retrieval query, filters implied by the tenant and active document status, candidate scores, selected excerpts, the structured model decision, and the final answer. If retrieval selects no evidence, application code returns an insufficient-evidence answer without calling Groq. A grounded answer requires citation IDs from the selected evidence; unknown citation IDs fail the run. The existing Day 1 demo tool is unavailable inside grounded runs. Live customer/account tools are not connected yet, so eligibility questions that require current facts must report what is missing.

Run `npm test` for local unit tests. After `migrate`, run `npm run test:db` to verify tenant isolation, deprecated-version exclusion, and search against PostgreSQL using temporary synthetic tenants; the test removes its records afterward. Retrieval scores and abstention thresholds still need a labeled evaluation set before production use.

```mermaid
flowchart LR
  A[Markdown document] --> B[Heading-aware chunks]
  B --> C[(PostgreSQL knowledge store)]
  C --> D[Local BGE embeddings]
  D --> C
  Q[Search query] --> E[Tenant and active filters]
  E --> F[Vector + keyword candidates]
  F --> G[Ranked evidence with citations]
```

`--demo` uses a deterministic model substitute and makes no API call. For a live Groq run, create a Groq API key and set it in your current PowerShell session without adding it to the repository:

```powershell
$env:MODEL_PROVIDER = 'groq' # default
$secureKey = Read-Host 'Groq API key' -AsSecureString
$env:GROQ_API_KEY = [System.Net.NetworkCredential]::new('', $secureKey).Password
Remove-Variable secureKey
npm run dev -- start 'What is the refund policy?'
```

The default Groq model is `openai/gpt-oss-120b`. Override it with `GROQ_MODEL` if needed. To use OpenAI instead, set `MODEL_PROVIDER=openai`, `OPENAI_API_KEY`, and `OPENAI_MODEL`. The hosted adapter uses structured model output for decisions and citation IDs. Native provider tool calling, live support data, approval, retries, recovery scheduling, and the UI are later increments.

If the process stops during a run, wait two minutes for the claim to expire and run `npm run dev -- resume RUN_ID --demo` (or omit `--demo` for the live adapter). The event log lets the worker avoid repeating a persisted tool step. The current demo tool is read-only; external write tools require stronger guarantees.
