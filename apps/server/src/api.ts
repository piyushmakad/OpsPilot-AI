import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { URL } from 'node:url';
import { RunRepository } from './repository.js';
import { createWorkflowRuntime } from './workflow-runtime.js';
import { DEMO_ACTOR, DEMO_TENANT, SCENARIOS, type Scenario } from './workflow-store.js';

type Identity = 'customer' | 'manager';

function sameSecret(actual: string, expected: string): boolean {
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function authenticate(req: IncomingMessage): Identity | null {
  const header = req.headers.authorization;
  if (!header?.startsWith('Basic ')) return null;
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const split = decoded.indexOf(':');
  if (split < 0) return null;
  const username = decoded.slice(0, split);
  const password = decoded.slice(split + 1);
  if (username === 'customer' && sameSecret(password, process.env.DEMO_CUSTOMER_PASSWORD!)) return 'customer';
  if (username === 'manager' && sameSecret(password, process.env.DEMO_MANAGER_PASSWORD!)) return 'manager';
  return null;
}

function json(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify(data));
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk as Uint8Array);
    size += buffer.length;
    if (size > 10000) throw new Error('Request body too large');
    chunks.push(buffer);
  }
  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('JSON object required');
  return parsed as Record<string, unknown>;
}

export async function serve(runs: RunRepository): Promise<void> {
  if (!process.env.DEMO_CUSTOMER_PASSWORD || !process.env.DEMO_MANAGER_PASSWORD ||
    process.env.DEMO_CUSTOMER_PASSWORD === process.env.DEMO_MANAGER_PASSWORD) {
    throw new Error('Set distinct DEMO_CUSTOMER_PASSWORD and DEMO_MANAGER_PASSWORD before serving');
  }
  const hostedReady = (process.env.MODEL_PROVIDER ?? 'groq') === 'openai'
    ? Boolean(process.env.OPENAI_API_KEY && process.env.OPENAI_MODEL)
    : Boolean(process.env.GROQ_API_KEY);
  const selection = process.env.DAY3_MODEL ?? (hostedReady ? 'hosted' : 'demo');
  if (selection !== 'hosted' && selection !== 'demo') throw new Error('DAY3_MODEL must be hosted or demo');
  const demo = selection === 'demo';
  const { store, knowledge, engine } = createWorkflowRuntime(runs, demo);
  const port = Number(process.env.PORT ?? 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true });
      const identity = authenticate(req);
      if (!identity) {
        res.setHeader('www-authenticate', 'Basic realm="OpsPilot local demo"');
        return json(res, 401, { error: 'Authentication required' });
      }
      if (req.method === 'GET' && url.pathname === '/api/scenarios') {
        return json(res, 200, { scenarios: SCENARIOS });
      }
      if (req.method === 'GET' && url.pathname === '/api/runs') {
        const result = await runs.pool.query(`SELECT id, request_text, scenario, status, output_text,
          created_at, updated_at FROM agent_runs WHERE workflow_version = 3 AND tenant_id = $1
          AND ($2 = 'manager' OR actor_id = $3) ORDER BY created_at DESC LIMIT 30`,
        [DEMO_TENANT, identity, DEMO_ACTOR]);
        return json(res, 200, { runs: result.rows });
      }
      if (req.method === 'POST' && url.pathname === '/api/runs') {
        if (identity !== 'customer') return json(res, 403, { error: 'Customer role required' });
        const input = await body(req);
        if (typeof input.goal !== 'string' || typeof input.scenario !== 'string' ||
          !SCENARIOS.includes(input.scenario as Scenario)) return json(res, 400, { error: 'Invalid goal or scenario' });
        const run = await store.create(input.goal, input.scenario as Scenario);
        return json(res, 201, { run });
      }
      const runMatch = /^\/api\/runs\/([0-9a-f-]{36})$/.exec(url.pathname);
      if (req.method === 'GET' && runMatch) {
        const run = await runs.get(runMatch[1]!);
        if (!run || run.workflowVersion !== 3 || run.tenantId !== DEMO_TENANT ||
          (identity === 'customer' && run.actorId !== DEMO_ACTOR)) return json(res, 404, { error: 'Run not found' });
        return json(res, 200, { run, events: await runs.events(run.id),
          ...(await store.inspector(run.id)) });
      }
      const replyMatch = /^\/api\/runs\/([0-9a-f-]{36})\/reply$/.exec(url.pathname);
      if (req.method === 'POST' && replyMatch) {
        if (identity !== 'customer') return json(res, 403, { error: 'Customer role required' });
        const input = await body(req);
        if (typeof input.answer !== 'string') return json(res, 400, { error: 'Answer required' });
        return json(res, await store.reply(replyMatch[1]!, DEMO_ACTOR, input.answer) ? 200 : 409,
          { ok: true });
      }
      if (req.method === 'GET' && url.pathname === '/api/approvals') {
        if (identity !== 'manager') return json(res, 403, { error: 'Manager role required' });
        return json(res, 200, { approvals: await store.approvals() });
      }
      const approvalMatch = /^\/api\/approvals\/([0-9a-f-]{36})\/decision$/.exec(url.pathname);
      if (req.method === 'POST' && approvalMatch) {
        if (identity !== 'manager') return json(res, 403, { error: 'Manager role required' });
        const input = await body(req);
        if (input.decision !== 'APPROVED' && input.decision !== 'REJECTED') {
          return json(res, 400, { error: 'Invalid approval decision' });
        }
        const ok = await store.decideApproval(approvalMatch[1]!, input.decision, 'demo-manager');
        return json(res, ok ? 200 : 409, { ok });
      }
      return json(res, 404, { error: 'Route not found' });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('API error:', message);
      return json(res, /Invalid|too large|required/i.test(message) ? 400 : 500, { error: message });
    }
  });
  let busy = false;
  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      await store.expireApprovals();
      for (const id of await store.dueRuns()) {
        try { await engine.execute(id); }
        catch (error) { console.error('Workflow run failed:', id, error); }
      }
    } catch (error) { console.error('Workflow worker failed:', error); }
    finally { busy = false; }
  }, 1000);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        console.log(`OpsPilot API listening on http://127.0.0.1:${port} (${demo ? 'demo' : 'hosted'} model)`);
        process.once('SIGINT', resolve);
        process.once('SIGTERM', resolve);
      });
    });
  } finally {
    clearInterval(timer);
    await new Promise<void>(resolve => server.close(() => resolve()));
    await knowledge.close();
  }
}
