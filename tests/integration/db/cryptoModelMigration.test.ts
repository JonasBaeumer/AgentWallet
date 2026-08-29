import { readFileSync } from 'fs';
import path from 'path';
import { prisma } from '@/db/client';

const migrationPath = path.resolve(
  __dirname,
  '../../../prisma/migrations/20260819070000_add_crypto_execution_models/migration.sql',
);

describe('crypto model migration backfill', () => {
  it('backfills a pre-migration Stripe intent to CARD without changing card history', async () => {
    const schema = `crypto_migration_${Date.now()}`;
    const sql = readFileSync(migrationPath, 'utf8');
    const alterStatement = sql.match(
      /ALTER TABLE "PurchaseIntent"\s+ADD COLUMN "paymentRail" "PaymentRail" NOT NULL DEFAULT 'CARD';/,
    )?.[0];
    expect(alterStatement).toBeDefined();

    try {
      await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
        await tx.$executeRawUnsafe(`SET LOCAL search_path TO "${schema}"`);
        await tx.$executeRawUnsafe(`CREATE TYPE "PaymentRail" AS ENUM ('CARD', 'CRYPTO')`);
        await tx.$executeRawUnsafe(
          'CREATE TABLE "User" ("id" TEXT PRIMARY KEY, "email" TEXT NOT NULL)',
        );
        await tx.$executeRawUnsafe(
          'CREATE TABLE "PurchaseIntent" ("id" TEXT PRIMARY KEY, "userId" TEXT NOT NULL)',
        );
        await tx.$executeRawUnsafe(
          'CREATE TABLE "VirtualCard" ("id" TEXT PRIMARY KEY, "intentId" TEXT NOT NULL, "last4" TEXT NOT NULL)',
        );
        await tx.$executeRawUnsafe(
          'CREATE TABLE "LedgerEntry" ("id" TEXT PRIMARY KEY, "intentId" TEXT NOT NULL, "amount" INTEGER NOT NULL)',
        );
        await tx.$executeRawUnsafe(
          'CREATE TABLE "AuditEvent" ("id" TEXT PRIMARY KEY, "intentId" TEXT NOT NULL, "event" TEXT NOT NULL)',
        );
        await tx.$executeRawUnsafe(
          `INSERT INTO "User" ("id", "email") VALUES ('legacy-user', 'legacy@test.local')`,
        );
        await tx.$executeRawUnsafe(
          `INSERT INTO "PurchaseIntent" ("id", "userId") VALUES ('legacy-intent', 'legacy-user')`,
        );
        await tx.$executeRawUnsafe(
          `INSERT INTO "VirtualCard" ("id", "intentId", "last4") VALUES ('legacy-card', 'legacy-intent', '4242')`,
        );
        await tx.$executeRawUnsafe(
          `INSERT INTO "LedgerEntry" ("id", "intentId", "amount") VALUES ('legacy-ledger', 'legacy-intent', 1250)`,
        );
        await tx.$executeRawUnsafe(
          `INSERT INTO "AuditEvent" ("id", "intentId", "event") VALUES ('legacy-audit', 'legacy-intent', 'CARD_ISSUED')`,
        );

        await tx.$executeRawUnsafe(alterStatement!);

        const intents = await tx.$queryRawUnsafe<Array<{ paymentRail: string }>>(
          'SELECT "paymentRail"::text AS "paymentRail" FROM "PurchaseIntent" WHERE "id" = \'legacy-intent\'',
        );
        const cards = await tx.$queryRawUnsafe<Array<{ last4: string }>>(
          'SELECT "last4" FROM "VirtualCard" WHERE "id" = \'legacy-card\'',
        );
        const history = await tx.$queryRawUnsafe<
          Array<{ email: string; amount: number; event: string }>
        >(
          `SELECT u."email", l."amount", a."event"
             FROM "User" u
             JOIN "PurchaseIntent" i ON i."userId" = u."id"
             JOIN "LedgerEntry" l ON l."intentId" = i."id"
             JOIN "AuditEvent" a ON a."intentId" = i."id"
            WHERE i."id" = 'legacy-intent'`,
        );
        expect(intents).toEqual([{ paymentRail: 'CARD' }]);
        expect(cards).toEqual([{ last4: '4242' }]);
        expect(history).toEqual([
          { email: 'legacy@test.local', amount: 1250, event: 'CARD_ISSUED' },
        ]);
      });
    } finally {
      await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await prisma.$disconnect();
    }
  });
});
