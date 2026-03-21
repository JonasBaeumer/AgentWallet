import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { getPaymentProvider } from '@/payments';

export async function webhookRoutes(fastify: FastifyInstance): Promise<void> {
  // Raw body is preserved for this path by app's content-type parser (required for Stripe signature verification).
  fastify.post('/v1/webhooks/stripe', {
    config: {
      rateLimit: {
        max: 500,
        timeWindow: '1 minute',
        keyGenerator: (req: FastifyRequest) => req.ip ?? 'unknown',
      },
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const signature = request.headers['stripe-signature'] as string;
    if (!signature) {
      return reply.status(400).send({ error: 'Missing stripe-signature header' });
    }

    let response: Record<string, unknown> = { received: true };
    try {
      const body = request.body as Buffer | string;
      response = await getPaymentProvider().handleWebhookEvent(body, signature);
    } catch (err) {
      // Log but always return 200 to Stripe to prevent retries
      fastify.log.error({ message: 'Stripe webhook processing error', error: String(err) });
    }

    // Stripe requires the Stripe-Version header in responses to issuing_authorization.request.
    // Without it Stripe reports "Invalid Stripe API version: " and declines the authorization.
    return reply.header('Stripe-Version', '2024-06-20').send(response);
  });
}
