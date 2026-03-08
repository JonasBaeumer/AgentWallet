-- AlterTable: make intentId nullable on AuditEvent to support non-intent audit events
-- (e.g. AGENT_LINKED, AGENT_UNLINKED) that are not scoped to a purchase intent.
ALTER TABLE "AuditEvent" ALTER COLUMN "intentId" DROP NOT NULL;
