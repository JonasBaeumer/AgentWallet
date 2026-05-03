-- Add PRIVACY_COM to the PaymentProvider enum.
-- Must run outside a transaction in older Postgres; ALTER TYPE ... ADD VALUE
-- is transactional on Postgres 12+, which is fine for our target.
ALTER TYPE "PaymentProvider" ADD VALUE 'PRIVACY_COM';
