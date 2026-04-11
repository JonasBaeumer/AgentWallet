import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { checkoutSimulateSchema } from '@/api/validators/checkout';
import { runSimulatedCheckout } from '@/payments/providers/stripe/checkoutSimulator';

export async function checkoutRoutes(fastify: FastifyInstance): Promise<void> {
  // POST /v1/checkout/simulate — simulate a merchant charging a virtual card
  // No auth: the card's own spending controls are the security layer.
  // Test mode only — uses raw card credentials to create a Stripe PaymentIntent,
  // triggering the Issuing authorization flow on the issuer side.
  fastify.post('/v1/checkout/simulate', async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = checkoutSimulateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Invalid input', details: parsed.error.errors });
    }

    let result;
    try {
      result = await runSimulatedCheckout(parsed.data);
    } catch (err: any) {
      if (err.name === 'TestModeOnlyError') {
        return reply.status(422).send({ error: err.message });
      }
      fastify.log.error({ message: 'checkoutSimulator: unexpected error', error: String(err) });
      return reply.status(500).send({ error: 'Unexpected error during checkout simulation' });
    }

    if (!result.success) {
      return reply.status(402).send({
        success: false,
        declineCode: result.declineCode,
        message: result.message,
      });
    }

    return reply.send({
      success: true,
      chargeId: result.chargeId,
      amount: result.amount,
      currency: result.currency,
    });
  });
}
