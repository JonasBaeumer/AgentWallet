-- Customer Smart Accounts are bound before the dedicated executor is
-- provisioned. Keep the aggregate incomplete but unavailable for payments until
-- issue #193 fills all executor identifiers.
ALTER TABLE "CryptoWalletAccount"
  ALTER COLUMN "executorAddress" DROP NOT NULL,
  ALTER COLUMN "executorAccountId" DROP NOT NULL,
  ALTER COLUMN "executorAccountName" DROP NOT NULL,
  ADD COLUMN "disconnectedAt" TIMESTAMP(3);

ALTER TABLE "CryptoWalletAccount"
  DROP CONSTRAINT "crypto_wallet_executor_identifiers";

ALTER TABLE "CryptoWalletAccount"
  ADD CONSTRAINT "crypto_wallet_executor_identifiers" CHECK (
    (
      "executorAddress" IS NULL AND
      "executorAccountId" IS NULL AND
      "executorAccountName" IS NULL
    ) OR (
      "executorAddress" IS NOT NULL AND
      "executorAccountId" IS NOT NULL AND
      "executorAccountName" IS NOT NULL AND
      length("executorAccountId") > 0 AND
      length("executorAccountName") > 0
    )
  );

CREATE UNIQUE INDEX "CryptoWalletAccount_customerAccountId_key"
  ON "CryptoWalletAccount"("customerAccountId");

-- validate_crypto_payment_scope() compares the permission's spender against the
-- wallet's executor. Now that executorAddress is nullable, that comparison
-- evaluates to NULL for an unprovisioned wallet, the enclosing OR chain is NULL
-- rather than true, and the scope check silently passes. Nothing can be spent
-- without an executor, so reject it explicitly rather than relying on the wallet
-- status alone to keep such a wallet out of the payment path.
CREATE FUNCTION require_crypto_payment_executor() RETURNS trigger AS $$
DECLARE
  executor_address TEXT;
BEGIN
  SELECT "executorAddress" INTO executor_address
    FROM "CryptoWalletAccount" WHERE "id" = NEW."walletAccountId";

  IF executor_address IS NULL THEN
    RAISE EXCEPTION 'crypto_payment_wallet_executor_missing';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Fires before "CryptoPayment_scope" by name order, so the clearer error wins.
CREATE TRIGGER "CryptoPayment_require_executor"
  BEFORE INSERT ON "CryptoPayment"
  FOR EACH ROW EXECUTE FUNCTION require_crypto_payment_executor();
