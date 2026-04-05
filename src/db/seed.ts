import 'dotenv/config';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import { logger } from '@/config/logger';

const log = logger.child({ module: 'db/seed' });

const prisma = new PrismaClient();

async function main() {
  // TELEGRAM_TEST_CHANNEL_ID (preferred) or TELEGRAM_TEST_CHAT_ID lets you receive real
  // Telegram notifications without going through the full OpenClaw pairing flow.
  // Get the chat ID by messaging @userinfobot on Telegram, then add it to .env.
  // Re-running the seed updates the existing user.
  const telegramChatId =
    process.env.TELEGRAM_TEST_CHANNEL_ID || process.env.TELEGRAM_TEST_CHAT_ID || null;

  const rawKey = crypto.randomBytes(32).toString('hex');
  const apiKeyHash = await bcrypt.hash(rawKey, 10);
  const apiKeyPrefix = rawKey.slice(0, 16);

  const existing = await prisma.user.findUnique({ where: { email: 'demo@agentpay.dev' } });

  const user = await prisma.user.upsert({
    where: { email: 'demo@agentpay.dev' },
    update: {
      apiKeyHash,
      apiKeyPrefix,
      ...(telegramChatId ? { telegramChatId } : {}),
    },
    create: {
      email: 'demo@agentpay.dev',
      mainBalance: 100000, // €1000.00 in cents
      maxBudgetPerIntent: 50000, // €500.00
      merchantAllowlist: [],
      mccAllowlist: [],
      apiKeyHash,
      apiKeyPrefix,
      ...(telegramChatId ? { telegramChatId } : {}),
    },
  });

  if (existing) {
    log.warn('WARNING: API key rotated — the previous key is now invalid. Save the new key printed above.');
  }

  const chatIdNote = user.telegramChatId
    ? user.telegramChatId
    : '(not set — add TELEGRAM_TEST_CHANNEL_ID or TELEGRAM_TEST_CHAT_ID to .env and re-run seed to receive Telegram notifications)';

  log.info({ userId: user.id, email: user.email, telegramChatId: chatIdNote }, 'Seeded demo user');
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
