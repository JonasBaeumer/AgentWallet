-- AlterTable: add nullable agentId to AuditEvent so agent-triggered events can be
-- distinguished per-agent. Populated from the X-Agent-Id header on /v1/agent/* routes.
ALTER TABLE "AuditEvent" ADD COLUMN "agentId" TEXT;

-- Index to support lookups of events by agent.
CREATE INDEX "AuditEvent_agentId_idx" ON "AuditEvent"("agentId");
