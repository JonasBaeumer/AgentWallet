export interface VirtualCardData {
  id: string;
  intentId: string;
  providerCardId: string;
  last4: string;
  revealedAt: Date | null;
  frozenAt: Date | null;
  cancelledAt: Date | null;
  createdAt: Date;
}

export interface CardReveal {
  number: string;
  cvc: string;
  expMonth: number;
  expYear: number;
  last4: string;
}

export class CardAlreadyRevealedError extends Error {
  constructor(intentId: string) {
    super(`Card for intent ${intentId} has already been revealed`);
    this.name = 'CardAlreadyRevealedError';
  }
}
