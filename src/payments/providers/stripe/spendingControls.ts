import Stripe from 'stripe';

export function buildSpendingControls(
  amountInSmallestUnit: number,
  mccAllowlist?: string[],
): Stripe.Issuing.CardCreateParams.SpendingControls {
  return {
    spending_limits: [{ amount: amountInSmallestUnit, interval: 'per_authorization' as const }],
    ...(mccAllowlist && mccAllowlist.length > 0
      ? {
          allowed_categories:
            mccAllowlist as Stripe.Issuing.CardCreateParams.SpendingControls.AllowedCategory[],
        }
      : {}),
  };
}
