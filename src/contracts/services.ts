import { PurchaseIntentData, IntentEvent } from './intent';
import { CardReveal, VirtualCardData } from './card';
import { PolicyResult, ApprovalDecisionData, ApprovalDecisionType } from './approval';
import { LedgerEntryData, PotData } from './ledger';
import { SearchIntentJob, CheckoutIntentJob } from './jobs';
import { AuditEventData } from './audit';

export interface IOrchestrator {
  transitionIntent(intentId: string, event: IntentEvent, payload?: Record<string, unknown>): Promise<PurchaseIntentData>;
  getIntentWithHistory(intentId: string): Promise<{ intent: PurchaseIntentData; auditEvents: AuditEventData[] }>;
}

export interface IssuingBalance {
  available: number;
  currency: string;
}

export interface IPaymentProvider {
  issueCard(intentId: string, amount: number, currency: string, options?: { mccAllowlist?: string[] }): Promise<VirtualCardData>;
  revealCard(intentId: string): Promise<CardReveal>;
  freezeCard(intentId: string): Promise<void>;
  cancelCard(intentId: string): Promise<void>;
  handleWebhookEvent(rawBody: Buffer | string, signature: string): Promise<void>;
  getIssuingBalance(currency: string): Promise<IssuingBalance>;
}

export interface IApprovalService {
  requestApproval(intentId: string): Promise<void>;
  recordDecision(intentId: string, decision: ApprovalDecisionType, actorId: string, reason?: string): Promise<ApprovalDecisionData>;
}

export interface ILedgerService {
  reserveForIntent(userId: string, intentId: string, amount: number): Promise<PotData>;
  settleIntent(intentId: string, actualAmount: number): Promise<void>;
  returnIntent(intentId: string): Promise<void>;
}

export interface IQueueProducer {
  enqueueSearch(intentId: string, payload: SearchIntentJob): Promise<void>;
  enqueueCheckout(intentId: string, payload: CheckoutIntentJob): Promise<void>;
}
