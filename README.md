# OpsPilot AI

One evolving full stack AI engineering project. This repository currently contains **Day 1 only**: a bounded agent execution loop and PostgreSQL-backed `AgentRun` state.

## Why this design

- `agent_runs` records what has actually happened in a workflow. A future conversation can contain many runs.
- `agent_run_events` preserves model decisions and tool results. After a crash, the engine examines the last durable event before taking another step.
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
  D -->|Need reasoning| G[Ask model for one decision]
  G --> H[Persist decision]
  H --> C
  D -->|Final decision| I[Complete run]
```

## Setup

Requires Node.js 20+, PostgreSQL, and an `opspilot` database. Install packages with `npm install` and run `npm run typecheck`.

In PowerShell:

```powershell
$env:DATABASE_URL = 'postgres://postgres:YOUR_PASSWORD@localhost:5432/opspilot'
npm run dev -- migrate
npm run dev -- start --demo 'What is the refund policy?'
npm run dev -- show RUN_ID
```

`--demo` uses a deterministic model substitute and makes no API call. For a live Groq run, create a Groq API key and set it in your current PowerShell session without adding it to the repository:

```powershell
$env:MODEL_PROVIDER = 'groq' # default
$secureKey = Read-Host 'Groq API key' -AsSecureString
$env:GROQ_API_KEY = [System.Net.NetworkCredential]::new('', $secureKey).Password
Remove-Variable secureKey
npm run dev -- start 'What is the refund policy?'
```

The default Groq model is `openai/gpt-oss-120b`. Override it with `GROQ_MODEL` if needed. To use OpenAI instead, set `MODEL_PROVIDER=openai`, `OPENAI_API_KEY`, and `OPENAI_MODEL`. The hosted adapter uses structured model output as the Day 1 decision contract. Native provider tool calling, real support data, approval, retries, recovery scheduling, and the UI are later increments.

If the process stops during a run, wait two minutes for the claim to expire and run `npm run dev -- resume RUN_ID --demo` (or omit `--demo` for the live adapter). The event log lets the worker avoid repeating a persisted tool step. The current demo tool is read-only; external write tools require stronger guarantees.
