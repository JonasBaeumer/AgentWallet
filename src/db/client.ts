import { Prisma, PrismaClient } from '@prisma/client';

// Prisma.Decimal is decimal.js, whose default precision is 20 significant
// digits. Crypto atomic amounts are DECIMAL(78,0) -- up to 78 digits -- so any
// arithmetic on them would round silently at the 20th digit and produce a wrong
// transfer amount with no error. Reading a value is exact regardless; this
// raises the bound for operations. Must run before PrismaClient is constructed.
// See docs/architecture/002-crypto-domain-model.md.
Prisma.Decimal.set({ precision: 100 });

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient };

export const prisma =
  globalForPrisma.prisma ||
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
  });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

export default prisma;
