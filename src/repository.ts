import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import type { AgentRun, RunEvent } from './types.js';

const { Pool } = pg;
type Row = Record<string, unknown>;

export class RunRepository {
  constructor(private readonly pool: pg.Pool) {}

  static fromEnvironment(): RunRepository {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
    return new RunRepository(new Pool({ connectionString: process.env.DATABASE_URL }));
  }

  async close(): Promise<void> { await this.pool.end(); }

  async migrate(): Promise<void> {
    for (const name of ['001_agent_runs.sql', '002_knowledge.sql', '003_embeddings.sql', '004_grounded_runs.sql']) {
      const path = fileURLToPath(new URL(`../sql/${name}`, import.meta.url));
      await this.pool.query(await readFile(path, 'utf8'));
    }
  }

  async create(requestText: string, tenantId = 'demo', ragEnabled = false): Promise<AgentRun> {
    const text = requestText.trim();
    if (!text || text.length > 10000) throw new Error('Request must contain 1 to 10,000 characters');
    const tenant = tenantId.trim();
    if (!tenant || tenant.length > 128) throw new Error('Tenant must contain 1 to 128 characters');
    const result = await this.pool.query(`INSERT INTO agent_runs
      (id, request_text, tenant_id, rag_enabled, workflow_version)
      VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [randomUUID(), text, tenant, ragEnabled, ragEnabled ? 2 : 1]);
    return mapRun(result.rows[0]);
  }

  async get(id: string): Promise<AgentRun | null> {
    const result = await this.pool.query('SELECT * FROM agent_runs WHERE id = $1', [id]);
    return result.rows[0] ? mapRun(result.rows[0]) : null;
  }

  async events(id: string): Promise<RunEvent[]> {
    const result = await this.pool.query('SELECT * FROM agent_run_events WHERE run_id = $1 ORDER BY sequence', [id]);
    return result.rows.map((row: Row) => ({
      runId: String(row.run_id), sequence: Number(row.sequence),
      kind: row.kind as RunEvent['kind'], payload: row.payload,
      createdAt: row.created_at as Date,
    }));
  }

  async claim(id: string): Promise<string | null> {
    const token = randomUUID();
    const result = await this.pool.query(`
      UPDATE agent_runs SET status = 'running', lease_token = $2,
        lease_expires_at = now() + interval '2 minutes', updated_at = now()
      WHERE id = $1 AND (status = 'pending' OR
        (status = 'running' AND lease_expires_at < now()))
      RETURNING id`, [id, token]);
    return result.rowCount ? token : null;
  }

  async append(id: string, token: string, kind: RunEvent['kind'], payload: unknown): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const owner = await client.query(`SELECT id FROM agent_runs
        WHERE id = $1 AND status = 'running' AND lease_token = $2
          AND lease_expires_at > now() FOR UPDATE`, [id, token]);
      if (!owner.rowCount) throw new Error('Run lease lost');
      await client.query(`INSERT INTO agent_run_events (run_id, sequence, kind, payload)
        SELECT $1, COALESCE(MAX(sequence), 0) + 1, $2, $3::jsonb
        FROM agent_run_events WHERE run_id = $1`, [id, kind, JSON.stringify(payload)]);
      await client.query(`UPDATE agent_runs SET updated_at = now(),
        lease_expires_at = now() + interval '2 minutes' WHERE id = $1`, [id]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  async finish(id: string, token: string, status: 'completed' | 'failed', text: string): Promise<void> {
    const result = await this.pool.query(`UPDATE agent_runs SET status = $3,
      output_text = CASE WHEN $3 = 'completed' THEN $4 ELSE NULL END,
      error_text = CASE WHEN $3 = 'failed' THEN $4 ELSE NULL END,
      completed_at = now(), updated_at = now(), lease_token = NULL,
      lease_expires_at = NULL
      WHERE id = $1 AND status = 'running' AND lease_token = $2
        AND lease_expires_at > now()`, [id, token, status, text]);
    if (!result.rowCount) throw new Error('Run lease lost');
  }
}

function mapRun(row: Row): AgentRun {
  return {
    id: String(row.id), tenantId: String(row.tenant_id),
    requestText: String(row.request_text), ragEnabled: Boolean(row.rag_enabled),
    status: row.status as AgentRun['status'],
    outputText: row.output_text as string | null,
    errorText: row.error_text as string | null,
    leaseToken: row.lease_token as string | null,
    leaseExpiresAt: row.lease_expires_at as Date | null,
    workflowVersion: Number(row.workflow_version),
    createdAt: row.created_at as Date, updatedAt: row.updated_at as Date,
  };
}
