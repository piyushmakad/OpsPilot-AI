# OpsPilot AI

One evolving full stack AI engineering project. Day 1 provides a bounded agent execution loop and PostgreSQL-backed `AgentRun` state. Day 2 adds tenant-aware Markdown ingestion, hybrid retrieval, and grounded agent runs with citations. Day 3 adds a durable multi-step refund agent, local MCP-style capabilities, approvals, retries, reconciliation, and a React run inspector.

## Day 3: run the local refund agent

Day 3 adds **workflow version 3** to the same `agent_runs` and `agent_run_events` tables. The Day 1 and Day 2 commands below still work. The payment and WhatsApp providers are local PostgreSQL-backed simulations; they make no real financial or messaging calls. `seed-day3` creates only synthetic demo data under tenant `demo-refunds`; it does not read your private Markdown files.

In PowerShell, use the same `DATABASE_URL` that already works for your local PostgreSQL instance. Then:

```powershell
npm install
npm run dev -- migrate
npm run dev -- seed-day3
$env:DEMO_CUSTOMER_PASSWORD = 'choose-a-local-customer-password'
$env:DEMO_MANAGER_PASSWORD = 'choose-a-different-manager-password'
npm run dev -- serve
```

`seed-day3` indexes the synthetic refund policy with the existing local BGE embedding model. Its first run may download that model. In another terminal, run `npm run ui:dev` and open `http://127.0.0.1:5173`. Log in as **customer** with the customer password to start a scenario. Switch to **manager** with the manager password to approve or reject a high-value refund. The API listens only on `127.0.0.1:8787`; Vite proxies `/api` to it.

If `GROQ_API_KEY` is set, the server defaults to the hosted model so Groq chooses each logical next step. Without a provider key, it defaults to `DemoWorkflowModel`, a deterministic teaching script. Set `DAY3_MODEL=demo` or `DAY3_MODEL=hosted` to select explicitly. With the hosted model, the selected synthetic policy excerpt and normalized mock account/payment facts are sent to Groq as model input. The application still validates every proposed tool call and side effect. The refund provider is behind [RefundProvider](src/workflow-provider.ts); the included implementation is a local simulation with fault injection.

You can also inspect a run from the CLI:

```powershell
npm run dev -- workflow start small --demo
npm run dev -- workflow start large-approve --demo
npm run dev -- workflow approvals
npm run dev -- workflow approve APPROVAL_ID
npm run dev -- workflow resume RUN_ID --demo
npm run dev -- workflow show RUN_ID
```

`workflow tick --demo` processes due retries and unknown outcomes once. The API's built-in worker does this continuously. `AUTO_REFUND_MAX_CENTS` controls the automatic threshold (default `10000`, or $100). The approval expires after 24 hours. The CLI's approval commands assume the local shell is trusted; the HTTP API requires the manager password for approval decisions.

Each seeded scenario has one payment. After demonstrating it, stop `serve`, run `npm run dev -- reset-day3`, then `npm run dev -- seed-day3` to replay all scenarios from clean synthetic state. Reset removes only Day 3 demo runs and payments under `demo-refunds`; it leaves your other tenants and documents alone.

### What to inspect

| Scenario | Expected trace |
| --- | --- |
| `small` | Plan → payment lookup → parallel account, detail, and RAG reads → refund → WhatsApp → completed |
| `large-approve` | Refund proposal → `waiting_approval` → manager approval → revalidation → refund → notification |
| `large-reject` | Approval rejection → no provider call or notification |
| `already-refunded` | Payment observation → revised plan → explanation, with no second refund |
| `provider-503` | First attempt returns 503 → `retry_scheduled` → same idempotency key on retry |
| `timeout` | Provider commits refund but response times out → `waiting_external` → reconciliation finds success → notification |
| `no-payment` | No successful payment → plan version 2 → no downstream policy or refund tools |

The LLM proposes plans and tool calls. [The Day 3 engine](src/workflow-engine.ts) checks exposure, schemas, read/write ordering, iteration and tool limits, and required observations. [The workflow store](src/workflow-store.ts) checks the requester and payment, exact full amount, the 30-day hard limit, approval, and the durable idempotency record. It rechecks these after approval. Retrieved policy helps the agent decide; it cannot override those checks. An uncertain provider outcome is reconciled before another attempt, and the notification record is unique per refund operation.

The local capability client in [workflow-tools.ts](src/workflow-tools.ts) separates tool definitions from execution. It is deliberately MCP-style, without an external MCP transport. The [React inspector](web/src/main.tsx) shows the goal, plan versions, sequential and parallel batches, latency, operation state, approval, idempotency key, and final response. It stores short decision summaries, not hidden chain-of-thought.

Run `npm test` for local tests, `npm run typecheck` for both TypeScript projects, and `npm run build` for the Node and React builds. After `migrate`, `npm run test:db` runs optional PostgreSQL tests with temporary synthetic tenants and cleans up its records. It requires `DATABASE_URL` in that shell.

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

## Day 4, slice 1: durable conversation and memory records

Run `npm run dev -- migrate` with your existing `DATABASE_URL`. This adds immutable raw conversation messages and versioned structured memory. A memory is addressed by tenant, user, exact scope, and fact key. Writing the same value again returns `deduplicated`; changing the value supersedes the previous row in one transaction. Different keys coexist. `history` keeps the old value for audit, while `list` returns only active, unexpired values. This slice uses explicit local CLI writes so you can inspect persistence before adding automated extraction or model context.

```powershell
npm run dev -- memory put demo piyush project opspilot project_decision database PostgreSQL
npm run dev -- memory put demo piyush project opspilot project_decision database PostgreSQL
npm run dev -- memory put demo piyush project opspilot project_decision database MongoDB
npm run dev -- memory list demo piyush project opspilot
npm run dev -- memory history demo piyush project opspilot database
```

For a global user preference, use `global -` in place of `project opspilot`. To inspect raw history, create a conversation, copy its returned UUID, and append messages:

```powershell
npm run dev -- conversation create demo piyush opspilot
npm run dev -- conversation add demo piyush CONVERSATION_ID user 'We chose PostgreSQL'
npm run dev -- conversation add demo piyush CONVERSATION_ID assistant 'Understood'
npm run dev -- conversation show demo piyush CONVERSATION_ID
```

The CLI is a trusted local developer interface. It does not authenticate end users; do not expose it as an HTTP memory-write endpoint. These explicit memory commands do not call Groq. Run `npm test` for local checks and `npm run test:db` for PostgreSQL behavior after migration.

## Day 4, slice 2: scoped memory search and context preview

Run `npm run dev -- migrate` again to add the memory full-text index. Search filters tenant, user, scope, active status, and expiry in SQL **before** ranking. It then scores keyword relevance, importance, confidence, source, scope specificity, and age; repeated keys are collapsed to one result. This is keyword retrieval, not semantic embedding search yet. Test with facts you entered in slice 1:

```powershell
npm run dev -- memory search demo piyush opspilot - 'Which database did we choose?'
npm run dev -- memory search demo piyush - - 'Which database did we choose?'
npm run dev -- context preview demo piyush opspilot - 200 'Which database did we choose?'
```

The first search should find the project database fact; the second should not because it omits the project scope. If you have a conversation UUID, substitute it for the second `-` in `context preview` to see recent raw messages alongside memories. Try a budget of `64` to see `dropped` entries. The token count is a planning estimate, not provider usage. This early preview command is read only; `context inspect RUN_ID` below shows the actual live context snapshot.

## Day 4 end-to-end: memory, summaries, and live context

Run the latest migrations first. Set `DATABASE_URL` and `GROQ_API_KEY` in your PowerShell session as in the setup sections above. `conversation learn` and live `start` send **the new user message** to Groq for structured memory extraction. Compaction sends older conversation messages and the previous summary to Groq. A grounded `start --rag` also sends selected knowledge excerpts, as described above. Keep private documents out of these commands unless that is intentional.

The extractor returns at most five candidates and a quote from the message for each. Application code checks the quote, confidence, importance, tenant/user identity, allowed scope, TTL, and memory versioning. A low-value message can yield zero memories while still remaining in raw history. A failed extraction leaves the raw message available for inspection. Only a trusted local CLI can issue these developer commands; the demo HTTP API does not expose arbitrary memory writes.

```powershell
cd 'D:\Piyush Projects\OpsPilot AI'
npm run dev -- migrate
npm test
npm run test:db
npm run dev -- conversation create demo piyush opspilot
```

Copy the returned UUID and replace `CONVERSATION_ID` below. These steps let you see each layer separately:

```powershell
# Extract an explicit project decision. Inspect versioning with memory history.
npm run dev -- conversation learn demo piyush CONVERSATION_ID --project=opspilot 'For OpsPilot use PostgreSQL.'
npm run dev -- memory list demo piyush project opspilot
npm run dev -- memory history demo piyush project opspilot database # use the key shown by memory list

# Build local BGE vectors and compare keyword with hybrid memory retrieval.
npm run dev -- memory index demo
npm run dev -- memory search demo piyush opspilot - 'Which database did we choose?'
npm run dev -- memory search demo piyush opspilot - --semantic 'What data store did we select?'

# Run the real agent with this user, project, and conversation context.
npm run dev -- start --tenant demo --user piyush --project opspilot --conversation CONVERSATION_ID 'Which database did we choose for OpsPilot?'
npm run dev -- context inspect RUN_ID
npm run dev -- conversation show demo piyush CONVERSATION_ID
```

`start` automatically appends and extracts the new user message, compacts older history if the unsummarized text crosses the threshold, and appends the final assistant answer transactionally with run completion. `context inspect` shows the selected data snapshot persisted before each model decision, including source labels, dropped items, and estimated tokens. The hosted model receives that selected data alongside its application instructions and exposed tool definitions. On recovery, an unchanged snapshot is reused. Set `CONTEXT_TOKEN_BUDGET` to change the total estimated budget (default 8,000; minimum 256). Token counts are estimates rather than provider usage.

To force a summarization exercise, add at least seven messages and use a low threshold. The latest six remain raw; the older messages are compressed into a structured summary while the full raw history stays in the database:

```powershell
npm run dev -- conversation add demo piyush CONVERSATION_ID user 'Current goal: finish Day 4 context engineering.'
# Add six more distinct messages with conversation add, then:
npm run dev -- conversation compact demo piyush CONVERSATION_ID 32
npm run dev -- conversation summary demo piyush CONVERSATION_ID
npm run dev -- conversation show demo piyush CONVERSATION_ID
```

The live context builder places the current request and run state first, then selected RAG policy, live tool observations, summary, recent raw messages, and relevant active memory. Structured live facts suppress older memory with the same key. Retrieved policy suppresses competing procedural memory. These are deterministic selection rules; model instructions also mark retrieved and historical content as untrusted. The Day 3 refund workflow still applies its existing validation and approval checks before any action. Enable semantic memory retrieval during live runs with `$env:MEMORY_SEMANTIC = '1'` after `memory index`; leave it unset to use faster keyword retrieval. The default similarity cutoff and ranking weights are starting values that need labeled evaluation in Day 5.

New runs link their exact incoming conversation message to the run. The context builder excludes that one message from recent history because the request is already present as a required item. Earlier repeated questions remain available as history. Run `npm run dev -- migrate` after updating the code to add this link; existing run snapshots remain immutable.
