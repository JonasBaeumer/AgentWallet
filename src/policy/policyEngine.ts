import { prisma } from '@/db/client';
import { PolicyResult } from '@/contracts';

interface IntentForPolicy {
  id: string;
  userId: string;
  maxBudget: number;
  metadata: Record<string, unknown>;
  createdAt: Date;
}

interface UserForPolicy {
  id: string;
  maxBudgetPerIntent: number;
  merchantAllowlist: string[];
  mccAllowlist: string[];
}

export async function evaluateIntent(
  intent: IntentForPolicy,
  user: UserForPolicy,
): Promise<PolicyResult> {
  const reasons: string[] = [];

  // Rule 1: amount <= user.maxBudgetPerIntent
  if (intent.maxBudget > user.maxBudgetPerIntent) {
    reasons.push(`Budget ${intent.maxBudget} exceeds user max ${user.maxBudgetPerIntent}`);
  }

  // Rule 2: merchant domain in allowlist (if user has one set)
  const merchantUrl = intent.metadata?.merchantUrl as string | undefined;
  if (user.merchantAllowlist.length > 0 && merchantUrl) {
    try {
      const url = new URL(merchantUrl);
      const domain = url.hostname;
      const allowed = user.merchantAllowlist.some(
        (allowedDomain) => domain === allowedDomain || domain.endsWith(`.${allowedDomain}`),
      );
      if (!allowed) {
        reasons.push(`Merchant domain ${domain} not in allowlist`);
      }
    } catch {
      reasons.push(`Invalid merchant URL: ${merchantUrl}`);
    }
  }

  // Rule 3: MCC category check (if user has restrictions and metadata has category)
  const mccCategory = intent.metadata?.mccCategory as string | undefined;
  if (user.mccAllowlist.length > 0 && mccCategory) {
    if (!user.mccAllowlist.includes(mccCategory)) {
      reasons.push(`MCC category ${mccCategory} not in allowlist`);
    }
  }

  // Rule 4: rate limit — max 3 intents per day
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const recentIntentCount = await prisma.purchaseIntent.count({
    where: {
      userId: user.id,
      createdAt: { gte: oneDayAgo },
      id: { not: intent.id },
    },
  });
  if (recentIntentCount >= 3) {
    reasons.push(`Rate limit exceeded: ${recentIntentCount} intents in the last 24 hours (max 3)`);
  }

  // Log evaluation to audit
  await prisma.auditEvent
    .create({
      data: {
        intentId: intent.id,
        actor: 'policy-engine',
        event: 'POLICY_EVALUATED',
        payload: { allowed: reasons.length === 0, reasons } as any,
      },
    })
    .catch(() => {}); // non-blocking

  if (reasons.length > 0) {
    return { allowed: false, reason: reasons.join('; ') };
  }
  return { allowed: true };
}
