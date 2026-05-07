export interface AuditEventData {
  id: string;
  intentId: string | null;
  actor: string;
  agentId: string | null;
  event: string;
  payload: Record<string, unknown>;
  createdAt: Date;
}

export type AgentAuditEvent = 'AGENT_LINKED' | 'AGENT_UNLINKED' | 'TELEGRAM_SETUP_CLEANED';
