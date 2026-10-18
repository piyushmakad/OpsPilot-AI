import { randomUUID } from 'node:crypto';
import type pg from 'pg';

export type ConversationRole = 'user' | 'assistant' | 'tool' | 'system';

function required(value: string, label: string, max: number): string {
  const clean = value.trim();
  if (!clean || clean.length > max) throw new Error(`${label} must contain 1 to ${max} characters`);
  return clean;
}

export class ConversationRepository {
  constructor(private readonly pool: pg.Pool) {}

  async create(tenantId: string, userId: string, projectId?: string): Promise<string> {
    const id = randomUUID();
    await this.pool.query(`INSERT INTO conversations (id, tenant_id, user_id, project_id) VALUES ($1,$2,$3,$4)`,
      [id, required(tenantId, 'Tenant', 128), required(userId, 'User', 128),
        projectId ? required(projectId, 'Project', 128) : null]);
    return id;
  }

  async append(tenantId: string, userId: string, conversationId: string,
    role: ConversationRole, content: string): Promise<{ id: string; sequence: number }> {
    if (!['user', 'assistant', 'tool', 'system'].includes(role)) throw new Error('Invalid conversation role');
    const message = required(content, 'Message', 20000);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const owner = await client.query(`SELECT id FROM conversations
        WHERE id = $1 AND tenant_id = $2 AND user_id = $3 FOR UPDATE`,
      [conversationId, required(tenantId, 'Tenant', 128), required(userId, 'User', 128)]);
      if (!owner.rowCount) throw new Error('Conversation not found for this tenant and user');
      const next = await client.query(`SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence
        FROM conversation_messages WHERE conversation_id = $1`, [conversationId]);
      const id = randomUUID();
      const sequence = Number(next.rows[0].sequence);
      await client.query(`INSERT INTO conversation_messages (id, conversation_id, sequence, role, content)
        VALUES ($1,$2,$3,$4,$5)`, [id, conversationId, sequence, role, message]);
      await client.query('UPDATE conversations SET updated_at = now() WHERE id = $1', [conversationId]);
      await client.query('COMMIT');
      return { id, sequence };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  async messages(tenantId: string, userId: string, conversationId: string): Promise<unknown[]> {
    const owner = await this.pool.query(`SELECT 1 FROM conversations
      WHERE id = $1 AND tenant_id = $2 AND user_id = $3`,
    [conversationId, required(tenantId, 'Tenant', 128), required(userId, 'User', 128)]);
    if (!owner.rowCount) throw new Error('Conversation not found for this tenant and user');
    const result = await this.pool.query(`SELECT id, sequence, role, content, created_at
      FROM conversation_messages WHERE conversation_id = $1 ORDER BY sequence`, [conversationId]);
    return result.rows;
  }
}
