-- Defense-in-depth for the AFTER_TTL ↔ cardTtlMinutes invariant (issue #143,
-- follow-up to #89 / PR #136). The application code already enforces this
-- coupling, but a DB-level CHECK rejects any future code path that writes
-- the broken state directly (scripts, ad-hoc updates, new endpoints, etc.).

-- Backfill any existing rows that would violate the constraint. We default to
-- 60 minutes — the same default used by the Telegram menu when the user opts
-- into AFTER_TTL — so prod data is never silently lost when the migration runs.
UPDATE "User"
SET "cardTtlMinutes" = 60
WHERE "cancelPolicy" = 'AFTER_TTL'
  AND ("cardTtlMinutes" IS NULL OR "cardTtlMinutes" <= 0);

ALTER TABLE "User"
ADD CONSTRAINT "user_after_ttl_requires_cardttlminutes"
CHECK (
  "cancelPolicy" <> 'AFTER_TTL'
  OR ("cardTtlMinutes" IS NOT NULL AND "cardTtlMinutes" > 0)
);
