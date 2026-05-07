import { z } from 'zod';

// Validates the `stripe-signature` header on the Stripe webhook route.
// Headers are lowercased by Fastify; we read the value with the lowercase key.
export const stripeWebhookHeadersSchema = z.object({
  'stripe-signature': z.string().min(1),
});

export type StripeWebhookHeaders = z.infer<typeof stripeWebhookHeadersSchema>;
