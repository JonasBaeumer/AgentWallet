-- PairingCode is the existing durable agent-registration record. Add a
-- one-way credential verifier and lifecycle fields without storing raw keys.
ALTER TABLE "PairingCode"
  ADD COLUMN "codeIssuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "credentialHash" TEXT,
  ADD COLUMN "credentialPrefix" TEXT,
  ADD COLUMN "credentialExpiresAt" TIMESTAMP(3),
  ADD COLUMN "credentialVersion" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "credentialRevokedAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "PairingCode_credentialPrefix_key"
  ON "PairingCode"("credentialPrefix");

-- Bind every intent to the agent linked when it was created. Existing intents
-- are backfilled from the user's current link; unlinked legacy intents remain
-- null and cannot be accessed through agent routes.
ALTER TABLE "PurchaseIntent" ADD COLUMN "agentId" TEXT;

UPDATE "PurchaseIntent" AS intent
SET "agentId" = app_user."agentId"
FROM "User" AS app_user
WHERE intent."userId" = app_user."id"
  AND app_user."agentId" IS NOT NULL;

CREATE INDEX "PurchaseIntent_agentId_idx" ON "PurchaseIntent"("agentId");
