import type { AllowedMerchantCategory, CardSpendingControls } from './stripeTypes';

export function buildSpendingControls(
  amountInSmallestUnit: number,
  mccAllowlist?: string[],
): CardSpendingControls {
  return {
    spending_limits: [{ amount: amountInSmallestUnit, interval: 'per_authorization' as const }],
    ...(mccAllowlist && mccAllowlist.length > 0
      ? {
          allowed_categories: mccAllowlist as AllowedMerchantCategory[],
        }
      : {}),
  };
}
