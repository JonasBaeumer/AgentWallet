-- Preserve the historical card lifecycle while identifying the execution rail
-- explicitly. PostgreSQL fills every existing intent with CARD when this
-- non-null column is added.
CREATE TYPE "PaymentRail" AS ENUM ('CARD', 'CRYPTO');
CREATE TYPE "CryptoProtocol" AS ENUM ('X402');
CREATE TYPE "CryptoNetwork" AS ENUM ('BASE_SEPOLIA');
CREATE TYPE "CryptoWalletStatus" AS ENUM (
  'PROVISIONING', 'ACTIVE', 'SUSPENDED', 'FAILED', 'CLOSED'
);
CREATE TYPE "CryptoPermissionStatus" AS ENUM (
  'PENDING', 'ACTIVE', 'REVOKED', 'EXPIRED', 'INVALID'
);
CREATE TYPE "CryptoPaymentStatus" AS ENUM (
  'AWAITING_APPROVAL', 'PREPARED', 'EXECUTING', 'SUBMITTED',
  'SUBMISSION_UNKNOWN', 'CONFIRMING', 'RECONCILING', 'SUCCEEDED',
  'FAILED_PRE_SUBMISSION', 'FAILED_ONCHAIN', 'DENIED', 'EXPIRED'
);

ALTER TABLE "PurchaseIntent"
  ADD COLUMN "paymentRail" "PaymentRail" NOT NULL DEFAULT 'CARD';

CREATE TABLE "CryptoWalletAccount" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "network" "CryptoNetwork" NOT NULL,
  "chainId" INTEGER NOT NULL,
  "customerAddress" TEXT NOT NULL,
  "customerAccountId" TEXT,
  "executorAddress" TEXT NOT NULL,
  "executorAccountId" TEXT NOT NULL,
  "executorAccountName" TEXT NOT NULL,
  "status" "CryptoWalletStatus" NOT NULL DEFAULT 'PROVISIONING',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CryptoWalletAccount_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "crypto_wallet_base_sepolia_chain" CHECK (
    "network" = 'BASE_SEPOLIA' AND "chainId" = 84532
  ),
  CONSTRAINT "crypto_wallet_customer_address" CHECK (
    "customerAddress" ~ '^0x[0-9a-fA-F]{40}$'
  ),
  CONSTRAINT "crypto_wallet_executor_address" CHECK (
    "executorAddress" ~ '^0x[0-9a-fA-F]{40}$'
  ),
  CONSTRAINT "crypto_wallet_executor_identifiers" CHECK (
    length("executorAccountId") > 0 AND length("executorAccountName") > 0
  )
);

CREATE TABLE "CryptoSpendPermission" (
  "id" TEXT NOT NULL,
  "walletAccountId" TEXT NOT NULL,
  "permissionHash" TEXT NOT NULL,
  "network" "CryptoNetwork" NOT NULL,
  "chainId" INTEGER NOT NULL,
  "customerAddress" TEXT NOT NULL,
  "spenderAddress" TEXT NOT NULL,
  "tokenAddress" TEXT NOT NULL,
  "assetSymbol" TEXT NOT NULL,
  "tokenDecimals" INTEGER NOT NULL,
  "allowanceAtomic" DECIMAL(78,0) NOT NULL,
  "periodSeconds" INTEGER NOT NULL,
  "validAfter" TIMESTAMP(3) NOT NULL,
  "validUntil" TIMESTAMP(3) NOT NULL,
  "status" "CryptoPermissionStatus" NOT NULL DEFAULT 'PENDING',
  "revokedAt" TIMESTAMP(3),
  "lastSyncedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CryptoSpendPermission_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "crypto_permission_base_sepolia_chain" CHECK (
    "network" = 'BASE_SEPOLIA' AND "chainId" = 84532
  ),
  CONSTRAINT "crypto_permission_addresses" CHECK (
    "customerAddress" ~ '^0x[0-9a-fA-F]{40}$' AND
    "spenderAddress" ~ '^0x[0-9a-fA-F]{40}$' AND
    "tokenAddress" ~ '^0x[0-9a-fA-F]{40}$'
  ),
  CONSTRAINT "crypto_permission_hash" CHECK (
    "permissionHash" ~ '^0x[0-9a-fA-F]{64}$'
  ),
  CONSTRAINT "crypto_permission_amount" CHECK (
    "allowanceAtomic" > 0 AND "periodSeconds" > 0 AND
    "tokenDecimals" BETWEEN 0 AND 255
  ),
  CONSTRAINT "crypto_permission_window" CHECK ("validUntil" > "validAfter"),
  CONSTRAINT "crypto_permission_revocation_state" CHECK (
    ("status" = 'REVOKED' AND "revokedAt" IS NOT NULL) OR
    ("status" <> 'REVOKED' AND "revokedAt" IS NULL)
  )
);

CREATE TABLE "CryptoPayment" (
  "id" TEXT NOT NULL,
  "intentId" TEXT NOT NULL,
  "walletAccountId" TEXT NOT NULL,
  "spendPermissionId" TEXT NOT NULL,
  "protocol" "CryptoProtocol" NOT NULL DEFAULT 'X402',
  "network" "CryptoNetwork" NOT NULL,
  "chainId" INTEGER NOT NULL,
  "displayCurrency" TEXT NOT NULL,
  "displayAmount" DECIMAL(36,18),
  "assetSymbol" TEXT NOT NULL,
  "tokenAddress" TEXT NOT NULL,
  "tokenDecimals" INTEGER NOT NULL,
  "amountAtomic" DECIMAL(78,0) NOT NULL,
  "recipientAddress" TEXT NOT NULL,
  "requestDigest" TEXT NOT NULL,
  "executionIdempotencyKey" TEXT NOT NULL,
  "transactionHash" TEXT,
  "userOperationHash" TEXT,
  "status" "CryptoPaymentStatus" NOT NULL DEFAULT 'AWAITING_APPROVAL',
  "submittedAt" TIMESTAMP(3),
  "confirmedAt" TIMESTAMP(3),
  "failedAt" TIMESTAMP(3),
  "reconciliationStartedAt" TIMESTAMP(3),
  "reconciledAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CryptoPayment_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "crypto_payment_base_sepolia_chain" CHECK (
    "network" = 'BASE_SEPOLIA' AND "chainId" = 84532
  ),
  CONSTRAINT "crypto_payment_addresses" CHECK (
    "tokenAddress" ~ '^0x[0-9a-fA-F]{40}$' AND
    "recipientAddress" ~ '^0x[0-9a-fA-F]{40}$'
  ),
  CONSTRAINT "crypto_payment_request_digest" CHECK (
    "requestDigest" ~ '^0x[0-9a-fA-F]{64}$'
  ),
  CONSTRAINT "crypto_payment_hashes" CHECK (
    ("transactionHash" IS NULL OR "transactionHash" ~ '^0x[0-9a-fA-F]{64}$') AND
    ("userOperationHash" IS NULL OR "userOperationHash" ~ '^0x[0-9a-fA-F]{64}$')
  ),
  CONSTRAINT "crypto_payment_amount" CHECK (
    "amountAtomic" > 0 AND "tokenDecimals" BETWEEN 0 AND 255 AND
    ("displayAmount" IS NULL OR "displayAmount" >= 0)
  ),
  CONSTRAINT "crypto_payment_symbols" CHECK (
    "displayCurrency" ~ '^[a-z]{3}$' AND "assetSymbol" ~ '^[A-Z0-9]{2,16}$'
  )
);

CREATE UNIQUE INDEX "CryptoWalletAccount_userId_network_key"
  ON "CryptoWalletAccount"("userId", "network");
CREATE UNIQUE INDEX "CryptoWalletAccount_network_customerAddress_key"
  ON "CryptoWalletAccount"("network", "customerAddress");
CREATE UNIQUE INDEX "CryptoWalletAccount_network_executorAddress_key"
  ON "CryptoWalletAccount"("network", "executorAddress");
CREATE UNIQUE INDEX "CryptoWalletAccount_executorAccountId_key"
  ON "CryptoWalletAccount"("executorAccountId");
CREATE UNIQUE INDEX "CryptoWalletAccount_executorAccountName_key"
  ON "CryptoWalletAccount"("executorAccountName");
CREATE INDEX "CryptoWalletAccount_status_idx" ON "CryptoWalletAccount"("status");

CREATE UNIQUE INDEX "CryptoSpendPermission_permissionHash_key"
  ON "CryptoSpendPermission"("permissionHash");
CREATE INDEX "CryptoSpendPermission_walletAccountId_status_idx"
  ON "CryptoSpendPermission"("walletAccountId", "status");
CREATE INDEX "CryptoSpendPermission_validUntil_idx"
  ON "CryptoSpendPermission"("validUntil");

CREATE UNIQUE INDEX "CryptoPayment_requestDigest_key" ON "CryptoPayment"("requestDigest");
CREATE UNIQUE INDEX "CryptoPayment_executionIdempotencyKey_key"
  ON "CryptoPayment"("executionIdempotencyKey");
CREATE UNIQUE INDEX "CryptoPayment_transactionHash_key" ON "CryptoPayment"("transactionHash");
CREATE UNIQUE INDEX "CryptoPayment_userOperationHash_key"
  ON "CryptoPayment"("userOperationHash");
CREATE INDEX "CryptoPayment_intentId_idx" ON "CryptoPayment"("intentId");
CREATE INDEX "CryptoPayment_status_updatedAt_idx" ON "CryptoPayment"("status", "updatedAt");
CREATE INDEX "CryptoPayment_spendPermissionId_idx"
  ON "CryptoPayment"("spendPermissionId");

-- Terminal records remain as immutable history, while a failed/denied/expired
-- request can be replaced without allowing concurrent execution for one intent.
CREATE UNIQUE INDEX "CryptoPayment_one_active_per_intent_key"
  ON "CryptoPayment"("intentId")
  WHERE "status" IN (
    'AWAITING_APPROVAL', 'PREPARED', 'EXECUTING', 'SUBMITTED',
    'SUBMISSION_UNKNOWN', 'CONFIRMING', 'RECONCILING'
  );

ALTER TABLE "CryptoWalletAccount"
  ADD CONSTRAINT "CryptoWalletAccount_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CryptoSpendPermission"
  ADD CONSTRAINT "CryptoSpendPermission_walletAccountId_fkey"
  FOREIGN KEY ("walletAccountId") REFERENCES "CryptoWalletAccount"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CryptoPayment"
  ADD CONSTRAINT "CryptoPayment_intentId_fkey"
  FOREIGN KEY ("intentId") REFERENCES "PurchaseIntent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CryptoPayment"
  ADD CONSTRAINT "CryptoPayment_walletAccountId_fkey"
  FOREIGN KEY ("walletAccountId") REFERENCES "CryptoWalletAccount"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CryptoPayment"
  ADD CONSTRAINT "CryptoPayment_spendPermissionId_fkey"
  FOREIGN KEY ("spendPermissionId") REFERENCES "CryptoSpendPermission"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- x402 terms are immutable from first persistence. A changed merchant
-- challenge must create a new request and approval flow.
CREATE FUNCTION prevent_crypto_payment_terms_update() RETURNS trigger AS $$
BEGIN
  IF NEW."intentId" IS DISTINCT FROM OLD."intentId"
    OR NEW."walletAccountId" IS DISTINCT FROM OLD."walletAccountId"
    OR NEW."spendPermissionId" IS DISTINCT FROM OLD."spendPermissionId"
    OR NEW."protocol" IS DISTINCT FROM OLD."protocol"
    OR NEW."network" IS DISTINCT FROM OLD."network"
    OR NEW."chainId" IS DISTINCT FROM OLD."chainId"
    OR NEW."displayCurrency" IS DISTINCT FROM OLD."displayCurrency"
    OR NEW."displayAmount" IS DISTINCT FROM OLD."displayAmount"
    OR NEW."assetSymbol" IS DISTINCT FROM OLD."assetSymbol"
    OR NEW."tokenAddress" IS DISTINCT FROM OLD."tokenAddress"
    OR NEW."tokenDecimals" IS DISTINCT FROM OLD."tokenDecimals"
    OR NEW."amountAtomic" IS DISTINCT FROM OLD."amountAtomic"
    OR NEW."recipientAddress" IS DISTINCT FROM OLD."recipientAddress"
    OR NEW."requestDigest" IS DISTINCT FROM OLD."requestDigest"
    OR NEW."executionIdempotencyKey" IS DISTINCT FROM OLD."executionIdempotencyKey"
  THEN
    RAISE EXCEPTION 'crypto_payment_terms_immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "CryptoPayment_terms_immutable"
  BEFORE UPDATE ON "CryptoPayment"
  FOR EACH ROW EXECUTE FUNCTION prevent_crypto_payment_terms_update();

-- Keep direct SQL and future workers inside the reviewed lifecycle, not only
-- callers that happen to use the TypeScript transition helper.
CREATE FUNCTION enforce_crypto_payment_status_transition() RETURNS trigger AS $$
BEGIN
  IF NEW."status" = OLD."status" THEN RETURN NEW; END IF;
  IF NOT (
    (OLD."status" = 'AWAITING_APPROVAL' AND NEW."status" IN ('PREPARED', 'DENIED', 'EXPIRED')) OR
    (OLD."status" = 'PREPARED' AND NEW."status" IN ('EXECUTING', 'FAILED_PRE_SUBMISSION', 'EXPIRED')) OR
    (OLD."status" = 'EXECUTING' AND NEW."status" IN ('SUBMITTED', 'SUBMISSION_UNKNOWN', 'FAILED_PRE_SUBMISSION')) OR
    (OLD."status" = 'SUBMITTED' AND NEW."status" IN ('CONFIRMING', 'RECONCILING', 'SUBMISSION_UNKNOWN')) OR
    (OLD."status" = 'SUBMISSION_UNKNOWN' AND NEW."status" = 'RECONCILING') OR
    (OLD."status" = 'CONFIRMING' AND NEW."status" IN ('SUCCEEDED', 'FAILED_ONCHAIN', 'RECONCILING', 'SUBMISSION_UNKNOWN')) OR
    (OLD."status" = 'RECONCILING' AND NEW."status" IN ('CONFIRMING', 'SUCCEEDED', 'FAILED_ONCHAIN', 'SUBMISSION_UNKNOWN'))
  ) THEN
    RAISE EXCEPTION 'crypto_payment_invalid_status_transition: % -> %', OLD."status", NEW."status";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "CryptoPayment_status_transition"
  BEFORE UPDATE OF "status" ON "CryptoPayment"
  FOR EACH ROW EXECUTE FUNCTION enforce_crypto_payment_status_transition();

-- Validate that every crypto record is scoped to the same customer wallet,
-- permission, network, token, and rail before it can enter the lifecycle.
CREATE FUNCTION validate_crypto_payment_scope() RETURNS trigger AS $$
DECLARE
  intent_user_id TEXT;
  intent_rail "PaymentRail";
  wallet_user_id TEXT;
  wallet_network "CryptoNetwork";
  wallet_chain_id INTEGER;
  wallet_customer_address TEXT;
  wallet_executor_address TEXT;
  permission_wallet_id TEXT;
  permission_network "CryptoNetwork";
  permission_chain_id INTEGER;
  permission_customer_address TEXT;
  permission_spender_address TEXT;
  permission_token TEXT;
  permission_decimals INTEGER;
  permission_allowance DECIMAL(78,0);
BEGIN
  SELECT "userId", "paymentRail" INTO intent_user_id, intent_rail
    FROM "PurchaseIntent" WHERE "id" = NEW."intentId";
  SELECT "userId", "network", "chainId", "customerAddress", "executorAddress"
    INTO wallet_user_id, wallet_network, wallet_chain_id,
         wallet_customer_address, wallet_executor_address
    FROM "CryptoWalletAccount" WHERE "id" = NEW."walletAccountId";
  SELECT "walletAccountId", "network", "chainId", "customerAddress",
         "spenderAddress", "tokenAddress", "tokenDecimals", "allowanceAtomic"
    INTO permission_wallet_id, permission_network, permission_chain_id,
         permission_customer_address, permission_spender_address,
         permission_token, permission_decimals, permission_allowance
    FROM "CryptoSpendPermission" WHERE "id" = NEW."spendPermissionId";

  IF intent_rail <> 'CRYPTO' OR intent_user_id <> wallet_user_id
    OR permission_wallet_id <> NEW."walletAccountId"
    OR wallet_network <> NEW."network" OR permission_network <> NEW."network"
    OR wallet_chain_id <> NEW."chainId" OR permission_chain_id <> NEW."chainId"
    OR lower(permission_customer_address) <> lower(wallet_customer_address)
    OR lower(permission_spender_address) <> lower(wallet_executor_address)
    OR lower(permission_token) <> lower(NEW."tokenAddress")
    OR permission_decimals <> NEW."tokenDecimals"
    OR NEW."amountAtomic" > permission_allowance
  THEN
    RAISE EXCEPTION 'crypto_payment_scope_mismatch';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "CryptoPayment_scope"
  BEFORE INSERT ON "CryptoPayment"
  FOR EACH ROW EXECUTE FUNCTION validate_crypto_payment_scope();
