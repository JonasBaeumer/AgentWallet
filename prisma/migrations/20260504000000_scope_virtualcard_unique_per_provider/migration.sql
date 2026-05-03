-- Scope VirtualCard.providerCardId uniqueness per provider.
-- Existing rows are all STRIPE-issued, so backfill with STRIPE before
-- swapping the singleton unique index for a composite one.

ALTER TABLE "VirtualCard"
  ADD COLUMN "provider" "PaymentProvider" NOT NULL DEFAULT 'STRIPE';

DROP INDEX "VirtualCard_providerCardId_key";

CREATE UNIQUE INDEX "VirtualCard_provider_providerCardId_key"
  ON "VirtualCard" ("provider", "providerCardId");
