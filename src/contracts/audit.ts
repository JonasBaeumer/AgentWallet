export interface AuditEventData {
  id: string;
  intentId: string | null;
  actor: string;
  event: string;
  payload: Record<string, unknown>;
  createdAt: Date;
}

export type AgentAuditEvent = 'AGENT_LINKED' | 'AGENT_UNLINKED';
