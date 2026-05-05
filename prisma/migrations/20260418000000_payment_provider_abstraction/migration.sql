-- CreateEnum
CREATE TYPE "PaymentProvider" AS ENUM ('STRIPE');

-- AlterTable User: add paymentProvider, rename stripeCardholderId -> providerCardholderId
ALTER TABLE "User" ADD COLUMN "paymentProvider" "PaymentProvider" NOT NULL DEFAULT 'STRIPE';
ALTER TABLE "User" RENAME COLUMN "stripeCardholderId" TO "providerCardholderId";

-- AlterTable VirtualCard: rename stripeCardId -> providerCardId, rename its unique index
ALTER TABLE "VirtualCard" RENAME COLUMN "stripeCardId" TO "providerCardId";
ALTER INDEX "VirtualCard_stripeCardId_key" RENAME TO "VirtualCard_providerCardId_key";
