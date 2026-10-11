import { z } from 'zod';

export const decisionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('final'), text: z.string().min(1),
    outcome: z.enum(['answered', 'insufficient_policy', 'missing_live_facts', 'conflicting_policy']).optional(),
    citations: z.array(z.string()).optional(),
  }),
  z.object({
    kind: z.literal('tool'),
    tool: z.literal('get_demo_policy'),
    arguments: z.object({}).strict(),
  }),
]);

export type Decision = z.infer<typeof decisionSchema>;
export type RunStatus = 'pending' | 'running' | 'completed' | 'failed';
export type RunEvent = {
  runId: string;
  sequence: number;
  kind: 'decision' | 'tool_result' | 'retrieval';
  payload: unknown;
  createdAt: Date;
};
export type AgentRun = {
  id: string;
  tenantId: string;
  requestText: string;
  ragEnabled: boolean;
  status: RunStatus;
  outputText: string | null;
  errorText: string | null;
  leaseToken: string | null;
  leaseExpiresAt: Date | null;
  workflowVersion: number;
  createdAt: Date;
  updatedAt: Date;
};
