import { prisma } from '@/db/client';
import {
  PotStatus,
  LedgerEntryType,
  PotData,
  InsufficientFundsError,
  IntentNotFoundError,
  UserNotFoundError,
} from '@/contracts';
import { logger } from '@/config/logger';

const log = logger.child({ module: 'ledger/potService' });

export async function reserveForIntent(
  userId: string,
  intentId: string,
  amount: number,
): Promise<PotData> {
  log.info({ intentId, userId, amount }, 'Reserving funds');
  return await prisma.$transaction(async (tx) => {
    // Fetch userId alongside currency so we can verify the intent belongs to
    // the caller. Without this check a mismatched (userId, intentId) pair
    // would attach this user's pot/ledger entries to another user's intent.
    const intent = await tx.purchaseIntent.findUnique({
      where: { id: intentId },
      select: { currency: true, userId: true },
    });
    if (!intent || intent.userId !== userId) throw new IntentNotFoundError(intentId);

    const user = await tx.user.findUnique({ where: { id: userId } });
    if (!user) throw new UserNotFoundError(userId);
    if (user.mainBalance < amount) throw new InsufficientFundsError(user.mainBalance, amount);

    // Deduct from mainBalance
    await tx.user.update({ where: { id: userId }, data: { mainBalance: { decrement: amount } } });

    // Create pot
    const pot = await tx.pot.create({
      data: {
        userId,
        intentId,
        reservedAmount: amount,
        settledAmount: 0,
        status: PotStatus.ACTIVE,
      },
    });

    // Record ledger entry
    await tx.ledgerEntry.create({
      data: {
        userId,
        intentId,
        type: LedgerEntryType.RESERVE,
        amount,
        currency: intent.currency,
      },
    });

    return pot as unknown as PotData;
  });
}

export async function settleIntent(intentId: string, actualAmount: number): Promise<void> {
  log.info({ intentId, actualAmount }, 'Settling intent');
  await prisma.$transaction(async (tx) => {
    const pot = await tx.pot.findUnique({ where: { intentId } });
    if (!pot) throw new IntentNotFoundError(intentId);

    const intent = await tx.purchaseIntent.findUnique({
      where: { id: intentId },
      select: { currency: true },
    });
    if (!intent) throw new IntentNotFoundError(intentId);

    const surplus = pot.reservedAmount - actualAmount;

    // Update pot
    await tx.pot.update({
      where: { intentId },
      data: { status: PotStatus.SETTLED, settledAmount: actualAmount },
    });

    // Return surplus to mainBalance
    if (surplus > 0) {
      await tx.user.update({
        where: { id: pot.userId },
        data: { mainBalance: { increment: surplus } },
      });
    }

    // Record ledger entry
    await tx.ledgerEntry.create({
      data: {
        userId: pot.userId,
        intentId,
        type: LedgerEntryType.SETTLE,
        amount: actualAmount,
        currency: intent.currency,
      },
    });
  });
}

export async function returnIntent(intentId: string): Promise<void> {
  log.info({ intentId }, 'Returning funds');
  await prisma.$transaction(async (tx) => {
    const pot = await tx.pot.findUnique({ where: { intentId } });
    if (!pot) return; // Nothing to return if pot doesn't exist

    if (pot.status !== PotStatus.ACTIVE) return; // Already settled/returned

    const intent = await tx.purchaseIntent.findUnique({
      where: { id: intentId },
      select: { currency: true },
    });
    if (!intent) throw new IntentNotFoundError(intentId);

    // Return full reserved amount
    await tx.user.update({
      where: { id: pot.userId },
      data: { mainBalance: { increment: pot.reservedAmount } },
    });

    // Update pot
    await tx.pot.update({ where: { intentId }, data: { status: PotStatus.RETURNED } });

    // Record ledger entry
    await tx.ledgerEntry.create({
      data: {
        userId: pot.userId,
        intentId,
        type: LedgerEntryType.RETURN,
        amount: pot.reservedAmount,
        currency: intent.currency,
      },
    });
  });
}
