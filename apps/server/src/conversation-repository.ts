import { randomUUID } from 'node:crypto';
import type pg from 'pg';

export type ConversationRole = 'user' | 'assistant' | 'tool' | 'system';
export interface ConversationMessage {
  id: string; sequence: number; role: ConversationRole; content: string; createdAt: Date;
}

function required(value: string, label: string, max: number): string {
  const clean = value.trim();
  if (!clean || clean.length > max) throw new Error(`${label} must contain 1 to ${max} characters`);
  return clean;
}

export class ConversationRepository {
  constructor(private readonly pool: pg.Pool) {}

  async get(tenantId: string, userId: string, conversationId: string): Promise<{ projectId: string | null } | null> {
    const result = await this.pool.query(`SELECT project_id FROM conversations
      WHERE id = $1 AND tenant_id = $2 AND user_id = $3`,
    [conversationId, required(tenantId, 'Tenant', 128), required(userId, 'User', 128)]);
    return result.rows[0] ? { projectId: result.rows[0].project_id as string | null } : null;
  }

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

  async messages(tenantId: string, userId: string, conversationId: string): Promise<ConversationMessage[]> {
    const owner = await this.pool.query(`SELECT 1 FROM conversations
      WHERE id = $1 AND tenant_id = $2 AND user_id = $3`,
    [conversationId, required(tenantId, 'Tenant', 128), required(userId, 'User', 128)]);
    if (!owner.rowCount) throw new Error('Conversation not found for this tenant and user');
    const result = await this.pool.query(`SELECT id, sequence, role, content, created_at
      FROM conversation_messages WHERE conversation_id = $1 ORDER BY sequence`, [conversationId]);
    return result.rows.map(row => ({ id: String(row.id), sequence: Number(row.sequence),
      role: row.role as ConversationRole, content: String(row.content), createdAt: row.created_at as Date }));
  }

  async recentMessages(tenantId: string, userId: string, conversationId: string,
    limit = 20): Promise<ConversationMessage[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid recent message limit');
    const result = await this.pool.query(`SELECT m.id, m.sequence, m.role, m.content, m.created_at
      FROM conversation_messages m JOIN conversations c ON c.id = m.conversation_id
      WHERE c.id = $1 AND c.tenant_id = $2 AND c.user_id = $3
      ORDER BY m.sequence DESC LIMIT $4`,
    [conversationId, required(tenantId, 'Tenant', 128), required(userId, 'User', 128), limit]);
    if (!result.rowCount) {
      const owner = await this.get(tenantId, userId, conversationId);
      if (!owner) throw new Error('Conversation not found for this tenant and user');
    }
    return result.rows.reverse().map(row => ({ id: String(row.id), sequence: Number(row.sequence),
      role: row.role as ConversationRole, content: String(row.content), createdAt: row.created_at as Date }));
  }
}
