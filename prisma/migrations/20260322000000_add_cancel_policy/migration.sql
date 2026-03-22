-- CreateEnum
CREATE TYPE "CardCancelPolicy" AS ENUM ('ON_TRANSACTION', 'IMMEDIATE', 'AFTER_TTL', 'MANUAL');

-- AlterTable: add cancel policy and optional TTL to User
ALTER TABLE "User" ADD COLUMN "cancelPolicy" "CardCancelPolicy" NOT NULL DEFAULT 'ON_TRANSACTION';
ALTER TABLE "User" ADD COLUMN "cardTtlMinutes" INTEGER;
