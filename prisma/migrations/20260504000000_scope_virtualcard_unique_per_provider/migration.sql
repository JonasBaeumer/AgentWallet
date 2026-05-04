-- Scope VirtualCard.providerCardId uniqueness per provider.
-- Existing rows are all STRIPE-issued, so we add the column with a STRIPE
-- default to backfill, then drop the default — going forward every
-- write site must set provider explicitly so a future provider cannot be
-- silently mis-tagged as STRIPE.

ALTER TABLE "VirtualCard"
  ADD COLUMN "provider" "PaymentProvider" NOT NULL DEFAULT 'STRIPE';

ALTER TABLE "VirtualCard"
  ALTER COLUMN "provider" DROP DEFAULT;

DROP INDEX "VirtualCard_providerCardId_key";

CREATE UNIQUE INDEX "VirtualCard_provider_providerCardId_key"
  ON "VirtualCard" ("provider", "providerCardId");
