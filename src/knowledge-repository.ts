import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { chunkMarkdown, type ChunkOptions } from './knowledge-chunk.js';

const { Pool } = pg;

export type DocumentInput = {
  tenantId: string;
  documentKey: string;
  version: number;
  title: string;
  source: string;
  status: 'ACTIVE' | 'DEPRECATED';
  markdown: string;
};

export class KnowledgeRepository {
  constructor(private readonly pool: pg.Pool) {}

  static fromEnvironment(): KnowledgeRepository {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
    return new KnowledgeRepository(new Pool({ connectionString: process.env.DATABASE_URL }));
  }

  async close(): Promise<void> { await this.pool.end(); }

  async ingest(input: DocumentInput, options: ChunkOptions = {}): Promise<{ documentId: string; chunks: number }> {
    const tenantId = input.tenantId.trim();
    const documentKey = input.documentKey.trim();
    const title = input.title.trim();
    const source = input.source.trim();
    if (!tenantId || !documentKey || !title || !source || !Number.isSafeInteger(input.version) || input.version < 1) {
      throw new Error('Document requires tenant, key, positive version, title, and source');
    }
    const chunks = chunkMarkdown(input.markdown, options);
    if (!chunks.length) throw new Error('Document contains no searchable content');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Serialize revisions of the same tenant/document pair.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [tenantId, documentKey]);
      if (input.status === 'ACTIVE') {
        const newer = await client.query(`SELECT version FROM knowledge_documents
          WHERE tenant_id = $1 AND document_key = $2 AND status = 'ACTIVE' AND version > $3`,
          [tenantId, documentKey, input.version]);
        if (newer.rowCount) throw new Error('Cannot activate an older document version');
        await client.query(`UPDATE knowledge_documents SET status = 'DEPRECATED', updated_at = now()
          WHERE tenant_id = $1 AND document_key = $2 AND version <> $3 AND status = 'ACTIVE'`,
          [tenantId, documentKey, input.version]);
      }
      const saved = await client.query(`INSERT INTO knowledge_documents
        (id, tenant_id, document_key, version, title, source, status)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (tenant_id, document_key, version) DO UPDATE SET
          title = EXCLUDED.title, source = EXCLUDED.source, status = EXCLUDED.status, updated_at = now()
        RETURNING id`, [randomUUID(), tenantId, documentKey, input.version, title, source, input.status]);
      const documentId = String(saved.rows[0].id);
      await client.query('DELETE FROM knowledge_chunks WHERE document_id = $1', [documentId]);
      for (const [index, chunk] of chunks.entries()) {
        await client.query(`INSERT INTO knowledge_chunks (id, document_id, chunk_index, section, content)
          VALUES ($1, $2, $3, $4, $5)`,
          [randomUUID(), documentId, index, chunk.section, chunk.content]);
      }
      await client.query('COMMIT');
      return { documentId, chunks: chunks.length };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }
}
