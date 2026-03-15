export class IllegalTransitionError extends Error {
  constructor(fromStatus: string, event: string) {
    super(`Illegal transition: cannot apply event ${event} to intent in status ${fromStatus}`);
    this.name = 'IllegalTransitionError';
  }
}

export class IntentNotFoundError extends Error {
  constructor(intentId: string) {
    super(`Intent not found: ${intentId}`);
    this.name = 'IntentNotFoundError';
  }
}

export class InvalidApprovalStateError extends Error {
  constructor(intentId: string, currentStatus: string) {
    super(`Intent ${intentId} is not in AWAITING_APPROVAL state (current: ${currentStatus})`);
    this.name = 'InvalidApprovalStateError';
  }
}

export class InsufficientIssuingBalanceError extends Error {
  public readonly available: number;
  public readonly required: number;
  public readonly currency: string;

  constructor(available: number, required: number, currency: string) {
    super(`Insufficient Stripe Issuing balance: available ${available}, required ${required} (${currency})`);
    this.name = 'InsufficientIssuingBalanceError';
    this.available = available;
    this.required = required;
    this.currency = currency;
  }
}
