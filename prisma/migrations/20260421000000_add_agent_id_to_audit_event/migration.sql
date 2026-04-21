-- AlterTable
ALTER TABLE "AuditEvent" ADD COLUMN "agentId" TEXT;

-- CreateIndex
CREATE INDEX "AuditEvent_intentId_agentId_idx" ON "AuditEvent"("intentId", "agentId");
