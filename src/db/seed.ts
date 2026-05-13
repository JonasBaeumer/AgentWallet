import 'dotenv/config';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import { logger } from '@/config/logger';

const log = logger.child({ module: 'db/seed' });

const prisma = new PrismaClient();

async function main() {
  // The demo user is created without a Telegram link. To receive notifications,
  // pair via /start <code> in Telegram — see docs/telegram-setup.md.
  const rawKey = crypto.randomBytes(32).toString('hex');
  const apiKeyHash = await bcrypt.hash(rawKey, 10);
  const apiKeyPrefix = rawKey.slice(0, 16);

  const existing = await prisma.user.findUnique({ where: { email: 'demo@agentpay.dev' } });

  const user = await prisma.user.upsert({
    where: { email: 'demo@agentpay.dev' },
    update: {
      apiKeyHash,
      apiKeyPrefix,
    },
    create: {
      email: 'demo@agentpay.dev',
      mainBalance: 100000, // €1000.00 in cents
      maxBudgetPerIntent: 50000, // €500.00
      merchantAllowlist: [],
      mccAllowlist: [],
      apiKeyHash,
      apiKeyPrefix,
    },
  });

  if (existing) {
    log.warn(
      'WARNING: API key rotated — the previous key is now invalid. Save the new key printed above.',
    );
  }

  log.info({ userId: user.id, email: user.email }, 'Seeded demo user');
  console.log(`Demo user API key (save this): ${rawKey}`);
}

main()
  .catch((e) => {
    log.error({ err: e }, 'Seed failed');
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
