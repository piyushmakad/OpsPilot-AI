# Day 1: the execution engine

The Day 1 goal is to turn a customer request into a durable run that can survive a process restart. This is a small vertical slice of OpsPilot AI, not a separate practice app.

## Follow one request through the code

1. `src/cli.ts` creates an `AgentRun` and invokes the engine. The CLI is temporary; a later API will call the same engine.
2. `src/repository.ts` writes a `pending` row. It then claims the run with one conditional PostgreSQL `UPDATE`. The lease token identifies the worker allowed to write its next step.
3. `src/engine.ts` reads the event history. If the last event is a tool decision, it executes the registered read-only tool. Otherwise it asks the model for one decision. It persists that decision *before* acting on it.
4. `src/model.ts` contains two adapters: the deterministic demo adapter and a live OpenAI Responses adapter. Both return the same validated `Decision` type.
5. The engine completes after a final decision or fails when the five-decision limit is reached.

## State versus history

`agent_runs.status` answers “where is this workflow now?” `agent_run_events` answers “what happened on the way here?” The model receives history to reason from; the database remains the source of truth for execution. A future conversation table can reference multiple run IDs.

## Crash example

Suppose a worker has persisted `decision: get_demo_policy` and then crashes. After the two-minute lease expires, `resume` claims the run. It sees that the latest event is the tool decision, executes the read-only tool, persists the result, and continues. It does not ask the model to choose that tool again.

If a worker crashes after a tool finishes but before its result is saved, the tool may run again. That is safe for this read-only demo tool. Before adding refunds or other write tools, we will add stable operation IDs, approval, provider idempotency, and reconciliation. A lease alone cannot guarantee exactly-once external effects.

## What to inspect while learning

Run the demo request from the README, then use `show RUN_ID`. Find the ordered `decision`, `tool_result`, and `decision` events. Trace the corresponding branches in `src/engine.ts`. Change the demo request to one that does not mention “policy,” “return,” or “refund” and observe the single final decision.

The live adapter uses structured output to produce the Day 1 decision. It does not yet use native provider tool calling. That integration belongs to the next increment, when the tool registry and authorization layer grow beyond the single safe demo tool.
