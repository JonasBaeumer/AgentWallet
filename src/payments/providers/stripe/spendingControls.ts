import type { Issuing as CardIssuing } from 'stripe/cjs/resources/Issuing/Cards';

export function buildSpendingControls(
  amountInSmallestUnit: number,
  mccAllowlist?: string[],
): CardIssuing.CardCreateParams.SpendingControls {
  return {
    spending_limits: [{ amount: amountInSmallestUnit, interval: 'per_authorization' as const }],
    ...(mccAllowlist && mccAllowlist.length > 0
      ? {
          allowed_categories:
            mccAllowlist as CardIssuing.CardCreateParams.SpendingControls.AllowedCategory[],
        }
      : {}),
  };
}
