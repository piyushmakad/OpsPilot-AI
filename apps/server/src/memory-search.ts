import type pg from 'pg';
import type { MemoryRecord } from './memory-repository.js';
import type { EmbeddingProvider } from './embedding.js';

export interface MemorySearchRequest {
  tenantId: string; userId: string; projectId?: string; conversationId?: string;
  query: string; limit?: number;
}

export interface MemoryHit {
  memory: MemoryRecord;
  score: number;
  lexicalRank: number;
  semanticSimilarity: number | null;
}

const STOP_WORDS = new Set(['a', 'an', 'and', 'are', 'can', 'did', 'do', 'for', 'from', 'how', 'i',
  'in', 'is', 'it', 'me', 'my', 'of', 'on', 'our', 'the', 'to', 'we', 'what', 'when', 'where', 'which',
  'who', 'why', 'with', 'you']);

export function searchTerms(query: string): string[] {
  return [...new Set((query.toLowerCase().match(/[a-z0-9]+/g) ?? [])
    .filter(word => word.length > 1 && !STOP_WORDS.has(word)))].slice(0, 12);
}

function required(value: string, name: string): string {
  const clean = value.trim();
  if (!clean || clean.length > 128) throw new Error(`${name} must contain 1 to 128 characters`);
  return clean;
}

export class MemorySearch {
  constructor(private readonly pool: pg.Pool, private readonly embeddings?: EmbeddingProvider) {}

  async warmup(): Promise<void> {
    if (this.embeddings) await this.embeddings.embedQuery('OpsPilot memory search');
  }

  async indexPending(tenantId: string, batchSize = 16): Promise<number> {
    if (!this.embeddings) throw new Error('Embedding provider is required for memory indexing');
    const tenant = required(tenantId, 'Tenant');
    if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 64)
      throw new Error('Batch size must be 1 to 64');
    let indexed = 0;
    while (true) {
      const pending = await this.pool.query(`SELECT id, key, value FROM memory_records
        WHERE tenant_id = $1 AND status = 'active' AND (expires_at IS NULL OR expires_at > now())
          AND (embedding IS NULL OR embedding_model IS DISTINCT FROM $2)
        ORDER BY created_at LIMIT $3`, [tenant, this.embeddings.modelId, batchSize]);
      if (!pending.rows.length) return indexed;
      const vectors = await this.embeddings.embedDocuments(pending.rows.map(row => `${row.key}: ${row.value}`));
      for (const [index, row] of pending.rows.entries()) {
        const vector = vectors[index];
        if (!vector || vector.length !== 384 || vector.some(n => !Number.isFinite(n)))
          throw new Error('Invalid memory embedding');
        const updated = await this.pool.query(`UPDATE memory_records SET embedding = $3::vector,
          embedding_model = $4, updated_at = now() WHERE id = $1 AND tenant_id = $2
          AND status = 'active'`, [row.id, tenant, `[${vector.join(',')}]`, this.embeddings.modelId]);
        indexed += updated.rowCount ?? 0;
      }
    }
  }

  async search(request: MemorySearchRequest): Promise<MemoryHit[]> {
    const tenant = required(request.tenantId, 'Tenant');
    const user = required(request.userId, 'User');
    const project = request.projectId ? required(request.projectId, 'Project') : '';
    const conversation = request.conversationId ? required(request.conversationId, 'Conversation') : '';
    if (!request.query.trim() || request.query.length > 2000) throw new Error('Memory query must contain 1 to 2,000 characters');
    const terms = searchTerms(request.query);
    if (!terms.length && !this.embeddings) return [];
    const limit = request.limit ?? 5;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw new Error('Memory limit must be 1 to 20');
    // Terms contain only ASCII letters and digits. An OR query lets a fact match one meaningful
    // term in a natural-language question; pg's English dictionary supplies stemming.
    const tsquery = terms.join(' | ');
    const lexical = terms.length ? await this.pool.query(`SELECT *, ts_rank_cd(
        to_tsvector('english', key || ' ' || value), to_tsquery('english', $5)) AS lexical_rank
      FROM memory_records
      WHERE tenant_id = $1 AND user_id = $2 AND status = 'active'
        AND (expires_at IS NULL OR expires_at > now())
        AND ((scope_type = 'global' AND scope_id = '')
          OR (scope_type = 'project' AND scope_id = $3 AND $3 <> '')
          OR (scope_type = 'conversation' AND scope_id = $4 AND $4 <> ''))
        AND to_tsvector('english', key || ' ' || value) @@ to_tsquery('english', $5)
      ORDER BY lexical_rank DESC LIMIT 100`, [tenant, user, project, conversation, tsquery])
      : { rows: [] as Record<string, unknown>[] };
    const embedder = this.embeddings;
    const semantic = embedder ? await (async () => {
      const vector = await embedder.embedQuery(request.query);
      if (vector.length !== 384 || vector.some(n => !Number.isFinite(n)))
        throw new Error('Invalid memory query embedding');
      return this.pool.query(`SELECT *, 1 - (embedding <=> $5::vector) AS semantic_similarity
        FROM memory_records WHERE tenant_id = $1 AND user_id = $2 AND status = 'active'
          AND (expires_at IS NULL OR expires_at > now()) AND embedding_model = $6
          AND embedding IS NOT NULL
          AND ((scope_type = 'global' AND scope_id = '')
            OR (scope_type = 'project' AND scope_id = $3 AND $3 <> '')
            OR (scope_type = 'conversation' AND scope_id = $4 AND $4 <> ''))
        ORDER BY embedding <=> $5::vector LIMIT 100`,
      [tenant, user, project, conversation, `[${vector.join(',')}]`, embedder.modelId]);
    })() : { rows: [] as Record<string, unknown>[] };
    const combined = new Map<string, Record<string, unknown>>();
    for (const row of lexical.rows) combined.set(String(row.id), row);
    for (const row of semantic.rows) {
      if (Number(row.semantic_similarity) < 0.55) continue;
      combined.set(String(row.id), { ...combined.get(String(row.id)), ...row });
    }
    const hits = [...combined.values()].map(row => {
      const lexicalRank = Number(row.lexical_rank ?? 0);
      const semanticSimilarity = row.semantic_similarity == null ? null : Number(row.semantic_similarity);
      const scopeBonus = row.scope_type === 'conversation' ? 0.12 : row.scope_type === 'project' ? 0.08 : 0;
      const authority = row.source_type === 'system' || row.source_type === 'tool_result' ? 0.12
        : row.source_type === 'user_message' ? 0.08 : 0;
      const ageDays = Math.max(0, (Date.now() - (row.created_at as Date).getTime()) / 86_400_000);
      const freshness = 0.1 / (1 + ageDays / 30);
      const score = lexicalRank + (semanticSimilarity ?? 0) * 0.6 + 0.15 * Number(row.importance) +
        0.1 * Number(row.confidence) + scopeBonus + authority + freshness;
      const memory: MemoryRecord = {
        id: String(row.id), tenantId: String(row.tenant_id), userId: String(row.user_id),
        scopeType: row.scope_type as MemoryRecord['scopeType'], scopeId: String(row.scope_id),
        type: row.type as MemoryRecord['type'],
        key: String(row.key), value: String(row.value), status: row.status as MemoryRecord['status'],
        version: Number(row.version), supersedesId: row.supersedes_id ? String(row.supersedes_id) : null,
        importance: Number(row.importance), confidence: Number(row.confidence),
        sourceType: row.source_type as MemoryRecord['sourceType'],
        sourceId: row.source_id ? String(row.source_id) : undefined,
        createdAt: row.created_at as Date,
        updatedAt: row.updated_at as Date,
        expiresAt: row.expires_at as Date | undefined,
      };
      return { memory, lexicalRank, semanticSimilarity, score };
    });
    hits.sort((a, b) => b.score - a.score || b.memory.createdAt.getTime() - a.memory.createdAt.getTime());
    const seen = new Set<string>();
    return hits.filter(hit => {
      if (seen.has(hit.memory.key)) return false;
      seen.add(hit.memory.key);
      return true;
    }).slice(0, limit);
  }
}
