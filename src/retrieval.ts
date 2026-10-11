import pg from 'pg';
import type { EmbeddingProvider } from './embedding.js';

const { Pool } = pg;

export type SearchCandidate = {
  chunkId: string;
  documentId: string;
  documentKey: string;
  version: number;
  title: string;
  section: string;
  source: string;
  content: string;
  semanticScore: number | null;
  lexicalScore: number | null;
  rankScore: number;
};

type CandidateRow = Omit<SearchCandidate, 'semanticScore' | 'lexicalScore' | 'rankScore'> & { score: number };
export type SearchOptions = {
  candidateCount?: number;
  topK?: number;
  minSemanticSimilarity?: number;
  minLexicalRank?: number;
};

export function fuseCandidates(
  semantic: CandidateRow[], lexical: CandidateRow[], options: SearchOptions = {},
): SearchCandidate[] {
  const topK = options.topK ?? 5;
  const minSemantic = options.minSemanticSimilarity ?? 0.55;
  const minLexical = options.minLexicalRank ?? 0.01;
  if (!Number.isInteger(topK) || topK < 1 || topK > 20 ||
      !Number.isFinite(minSemantic) || minSemantic < -1 || minSemantic > 1 ||
      !Number.isFinite(minLexical) || minLexical < 0) {
    throw new Error('Invalid search ranking options');
  }
  const merged = new Map<string, SearchCandidate>();
  const add = (rows: CandidateRow[], kind: 'semantic' | 'lexical', threshold: number) => {
    rows.forEach((row, index) => {
      if (row.score < threshold) return;
      const existing = merged.get(row.chunkId) ?? {
        chunkId: row.chunkId, documentId: row.documentId,
        documentKey: row.documentKey, version: row.version,
        title: row.title, section: row.section, source: row.source,
        content: row.content, semanticScore: null, lexicalScore: null, rankScore: 0,
      };
      existing.rankScore += 1 / (60 + index + 1);
      if (kind === 'semantic') existing.semanticScore = row.score;
      else existing.lexicalScore = row.score;
      merged.set(row.chunkId, existing);
    });
  };
  add(semantic, 'semantic', minSemantic);
  add(lexical, 'lexical', minLexical);
  return [...merged.values()].sort((a, b) => b.rankScore - a.rankScore).slice(0, topK);
}

export class KnowledgeSearch {
  constructor(private readonly pool: pg.Pool, private readonly embeddings: EmbeddingProvider) {}

  static fromEnvironment(embeddings: EmbeddingProvider): KnowledgeSearch {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
    return new KnowledgeSearch(new Pool({ connectionString: process.env.DATABASE_URL }), embeddings);
  }

  async close(): Promise<void> { await this.pool.end(); }

  async warmup(): Promise<void> {
    await this.embeddings.embedQuery('OpsPilot knowledge search');
  }

  async indexPending(tenantId: string, batchSize = 16): Promise<number> {
    if (!tenantId.trim() || !Number.isInteger(batchSize) || batchSize < 1 || batchSize > 64) {
      throw new Error('Tenant and batch size (1-64) are required');
    }
    let indexed = 0;
    while (true) {
      const pending = await this.pool.query<{ id: string; title: string; section: string; content: string }>(`
        SELECT c.id, d.title, c.section, c.content FROM knowledge_chunks c
        JOIN knowledge_documents d ON d.id = c.document_id
        WHERE d.tenant_id = $1 AND d.status = 'ACTIVE'
          AND (c.embedding IS NULL OR c.embedding_model IS DISTINCT FROM $2)
        ORDER BY d.document_key, d.version, c.chunk_index LIMIT $3`,
        [tenantId, this.embeddings.modelId, batchSize]);
      if (!pending.rows.length) return indexed;
      const vectors = await this.embeddings.embedDocuments(pending.rows.map(row =>
        `${row.title}\n${row.section}\n${row.content}`));
      if (vectors.length !== pending.rows.length) throw new Error('Embedding count did not match chunk count');
      for (const [index, row] of pending.rows.entries()) {
        const vector = vectors[index];
        if (!vector) throw new Error('Missing chunk embedding');
        const updated = await this.pool.query(`UPDATE knowledge_chunks c
          SET embedding = $3::vector, embedding_model = $4
          FROM knowledge_documents d
          WHERE c.id = $1 AND c.document_id = d.id AND d.tenant_id = $2 AND d.status = 'ACTIVE'`,
          [row.id, tenantId, vectorLiteral(vector), this.embeddings.modelId]);
        indexed += updated.rowCount ?? 0;
      }
    }
  }

  async search(tenantId: string, query: string, options: SearchOptions = {}): Promise<SearchCandidate[]> {
    if (!tenantId.trim() || !query.trim() || query.length > 2000) {
      throw new Error('Tenant and a query of at most 2,000 characters are required');
    }
    const candidateCount = options.candidateCount ?? 15;
    if (!Number.isInteger(candidateCount) || candidateCount < 1 || candidateCount > 100) {
      throw new Error('candidateCount must be between 1 and 100');
    }
    const vector = vectorLiteral(await this.embeddings.embedQuery(query));
    const columns = `c.id AS chunk_id, d.id AS document_id, d.document_key, d.version,
      d.title, c.section, d.source, c.content`;
    const [semantic, lexical] = await Promise.all([
      this.pool.query(`SELECT ${columns}, 1 - (c.embedding <=> $3::vector) AS score
        FROM knowledge_chunks c JOIN knowledge_documents d ON d.id = c.document_id
        WHERE d.tenant_id = $1 AND d.status = 'ACTIVE' AND c.embedding_model = $4
          AND c.embedding IS NOT NULL
        ORDER BY c.embedding <=> $3::vector LIMIT $2`,
        [tenantId, candidateCount, vector, this.embeddings.modelId]),
      this.pool.query(`SELECT ${columns}, CASE
          WHEN lower(d.document_key) = lower($3) OR lower(d.title) = lower($3) THEN 10
          ELSE ts_rank_cd(c.search_vector, websearch_to_tsquery('english', $3))
        END AS score
        FROM knowledge_chunks c JOIN knowledge_documents d ON d.id = c.document_id
        WHERE d.tenant_id = $1 AND d.status = 'ACTIVE'
          AND (c.search_vector @@ websearch_to_tsquery('english', $3)
            OR lower(d.document_key) = lower($3) OR lower(d.title) = lower($3))
        ORDER BY score DESC LIMIT $2`,
        [tenantId, candidateCount, query]),
    ]);
    return fuseCandidates(semantic.rows.map(mapCandidate), lexical.rows.map(mapCandidate), options);
  }
}

function vectorLiteral(vector: number[]): string {
  if (vector.length !== 384 || vector.some(value => !Number.isFinite(value))) {
    throw new Error('Expected a finite 384-dimensional embedding');
  }
  return `[${vector.join(',')}]`;
}

function mapCandidate(row: Record<string, unknown>): CandidateRow {
  return {
    chunkId: String(row.chunk_id), documentId: String(row.document_id),
    documentKey: String(row.document_key), version: Number(row.version),
    title: String(row.title), section: String(row.section), source: String(row.source),
    content: String(row.content), score: Number(row.score),
  };
}
