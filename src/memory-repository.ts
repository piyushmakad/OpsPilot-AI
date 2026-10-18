import { createHash, randomUUID } from 'node:crypto';
import type pg from 'pg';

export type MemoryScope = 'global' | 'project' | 'conversation';
export type MemoryType = 'semantic' | 'episodic' | 'procedural' | 'project_decision' | 'user_preference';
export type MemorySource = 'user_message' | 'tool_result' | 'system' | 'model_inference';

export interface MemoryInput {
  tenantId: string; userId: string; scopeType: MemoryScope; scopeId: string;
  type: MemoryType; key: string; value: string;
  sourceType?: MemorySource; sourceId?: string;
  importance?: number; confidence?: number; expiresAt?: Date;
}

export interface MemoryRecord extends MemoryInput {
  id: string; version: number; status: 'active' | 'superseded' | 'archived';
  supersedesId: string | null; createdAt: Date;
}

const types = new Set<MemoryType>(['semantic', 'episodic', 'procedural', 'project_decision', 'user_preference']);
const sources = new Set<MemorySource>(['user_message', 'tool_result', 'system', 'model_inference']);

export function normalizeMemoryKey(key: string): string {
  return key.trim().toLowerCase().replace(/\s+/g, '_');
}

export function memoryFingerprint(value: string, type: MemoryType): string {
  return createHash('sha256').update(`${type}\0${value.trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US')}`)
    .digest('hex');
}

function bounded(value: string, name: string, max: number): string {
  const clean = value.trim();
  if (!clean || clean.length > max) throw new Error(`${name} must contain 1 to ${max} characters`);
  return clean;
}

function scope(tenantId: string, userId: string, scopeType: MemoryScope, scopeId: string):
  [string, string, MemoryScope, string] {
  const tenant = bounded(tenantId, 'Tenant', 128);
  const user = bounded(userId, 'User', 128);
  if (!['global', 'project', 'conversation'].includes(scopeType)) throw new Error('Invalid memory scope');
  const id = scopeType === 'global' ? '' : bounded(scopeId, 'Scope ID', 128);
  if (scopeType === 'global' && scopeId !== '' && scopeId !== '-') throw new Error('Global scope has no ID');
  if (scopeType === 'conversation' && !/^[0-9a-f-]{36}$/i.test(id)) throw new Error('Conversation scope requires a UUID');
  return [tenant, user, scopeType, id];
}

function map(row: Record<string, unknown>): MemoryRecord {
  return {
    id: String(row.id), tenantId: String(row.tenant_id), userId: String(row.user_id),
    scopeType: row.scope_type as MemoryScope, scopeId: String(row.scope_id),
    type: row.type as MemoryType, key: String(row.key), value: String(row.value),
    sourceType: row.source_type as MemorySource, sourceId: row.source_id ? String(row.source_id) : undefined,
    importance: Number(row.importance), confidence: Number(row.confidence),
    expiresAt: row.expires_at as Date | undefined, version: Number(row.version),
    status: row.status as MemoryRecord['status'], supersedesId: row.supersedes_id ? String(row.supersedes_id) : null,
    createdAt: row.created_at as Date,
  };
}

export class MemoryRepository {
  constructor(private readonly pool: pg.Pool) {}

  async put(input: MemoryInput): Promise<{ action: 'created' | 'superseded' | 'deduplicated'; record: MemoryRecord }> {
    const [tenant, user, scopeType, scopeId] = scope(input.tenantId, input.userId, input.scopeType, input.scopeId);
    const key = bounded(normalizeMemoryKey(input.key), 'Memory key', 128);
    const value = bounded(input.value, 'Memory value', 4000);
    if (!types.has(input.type)) throw new Error('Invalid memory type');
    const sourceType = input.sourceType ?? 'user_message';
    if (!sources.has(sourceType)) throw new Error('Invalid memory source');
    const importance = input.importance ?? 0.5;
    const confidence = input.confidence ?? 1;
    if (![importance, confidence].every(n => Number.isFinite(n) && n >= 0 && n <= 1))
      throw new Error('Importance and confidence must be between 0 and 1');
    if (input.expiresAt && (!Number.isFinite(input.expiresAt.getTime()) || input.expiresAt <= new Date()))
      throw new Error('Expiration must be in the future');
    const fingerprint = memoryFingerprint(value, input.type);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Locks the logical fact slot even if its first row has not been inserted yet.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [JSON.stringify([tenant, user, scopeType, scopeId, key])]);
      if (scopeType === 'conversation') {
        const owner = await client.query(`SELECT 1 FROM conversations
          WHERE id = $1 AND tenant_id = $2 AND user_id = $3`, [scopeId, tenant, user]);
        if (!owner.rowCount) throw new Error('Conversation not found for this tenant and user');
      }
      const prior = await client.query(`SELECT * FROM memory_records WHERE tenant_id = $1 AND user_id = $2
        AND scope_type = $3 AND scope_id = $4 AND key = $5 AND status = 'active' FOR UPDATE`,
      [tenant, user, scopeType, scopeId, key]);
      const active = prior.rows[0];
      if (active && active.value_fingerprint === fingerprint &&
          (!active.expires_at || new Date(active.expires_at) > new Date())) {
        await client.query('COMMIT');
        return { action: 'deduplicated', record: map(active) };
      }
      if (active) await client.query(`UPDATE memory_records SET status = 'superseded', updated_at = now() WHERE id = $1`, [active.id]);
      const version = await client.query(`SELECT COALESCE(MAX(version), 0) + 1 AS next FROM memory_records
        WHERE tenant_id = $1 AND user_id = $2 AND scope_type = $3 AND scope_id = $4 AND key = $5`,
      [tenant, user, scopeType, scopeId, key]);
      const inserted = await client.query(`INSERT INTO memory_records
        (id, tenant_id, user_id, type, scope_type, scope_id, key, value, value_fingerprint,
         status, version, supersedes_id, importance, confidence, source_type, source_id, expires_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'active',$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
      [randomUUID(), tenant, user, input.type, scopeType, scopeId, key, value, fingerprint,
        version.rows[0].next, active?.id ?? null, importance, confidence, sourceType,
        input.sourceId ?? null, input.expiresAt ?? null]);
      await client.query('COMMIT');
      return { action: active ? 'superseded' : 'created', record: map(inserted.rows[0]) };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  async list(tenantId: string, userId: string, scopeType: MemoryScope, scopeId: string): Promise<MemoryRecord[]> {
    const values = scope(tenantId, userId, scopeType, scopeId);
    const result = await this.pool.query(`SELECT * FROM memory_records WHERE tenant_id = $1 AND user_id = $2
      AND scope_type = $3 AND scope_id = $4 AND status = 'active'
      AND (expires_at IS NULL OR expires_at > now()) ORDER BY key`, values);
    return result.rows.map(map);
  }

  async history(tenantId: string, userId: string, scopeType: MemoryScope, scopeId: string,
    key: string): Promise<MemoryRecord[]> {
    const values = [...scope(tenantId, userId, scopeType, scopeId),
      bounded(normalizeMemoryKey(key), 'Memory key', 128)];
    const result = await this.pool.query(`SELECT * FROM memory_records WHERE tenant_id = $1 AND user_id = $2
      AND scope_type = $3 AND scope_id = $4 AND key = $5 ORDER BY version`, values);
    return result.rows.map(map);
  }
}
