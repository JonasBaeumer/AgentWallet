import { PotStatus } from './ledger';

export interface ReconciliationReport {
  intentId: string;
  internal: {
    reserved: number;
    settled: number;
    potStatus: PotStatus | null;
    ledgerEntries: string[]; // e.g. ["RESERVE:5000", "SETTLE:3500"]
  };
  stripe: {
    cardStatus: 'active' | 'inactive' | 'canceled';
    transactions: Array<{ id: string; amount: number; type: string }>;
    totalCaptured: number;
  } | null; // null if no VirtualCard exists for this intent
  inSync: boolean;
  discrepancies: string[];
}
