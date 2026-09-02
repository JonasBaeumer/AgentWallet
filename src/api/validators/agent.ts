import { z } from 'zod';

export const agentQuoteSchema = z.object({
  intentId: z.string().min(1),
  merchantName: z.string().min(1),
  merchantUrl: z.string().url(),
  price: z.number().int().positive(),
  currency: z.string().length(3).default('eur'),
});

export const agentResultSchema = z
  .object({
    intentId: z.string().min(1),
    success: z.boolean(),
    actualAmount: z.number().int().nonnegative().optional(),
    receiptUrl: z.string().url().optional(),
    errorMessage: z.string().optional(),
  })
  .superRefine((data, ctx) => {
    // A successful report without an amount would settle 0 and refund the whole
    // reservation — require the amount so success always carries what was spent.
    if (data.success && data.actualAmount === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['actualAmount'],
        message: 'actualAmount is required when success is true',
      });
    }
  });

export const agentRegisterSchema = z.object({
  agentId: z.string().min(1).optional(),
});

export type AgentQuoteInput = z.infer<typeof agentQuoteSchema>;
export type AgentResultInput = z.infer<typeof agentResultSchema>;
export type AgentRegisterInput = z.infer<typeof agentRegisterSchema>;
