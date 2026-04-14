import {
  LedgerEntryType as PrismaLedgerEntryType,
  PotStatus as PrismaPotStatus,
} from '@prisma/client';

export { PrismaLedgerEntryType as LedgerEntryType, PrismaPotStatus as PotStatus };

export interface LedgerEntryData {
  id: string;
  userId: string;
  intentId: string;
  type: PrismaLedgerEntryType;
  amount: number;
  currency: string;
  createdAt: Date;
}

export interface PotData {
  id: string;
  userId: string;
  intentId: string;
  reservedAmount: number;
  settledAmount: number;
  status: PrismaPotStatus;
  createdAt: Date;
  updatedAt: Date;
}

export class InsufficientFundsError extends Error {
  constructor(available: number, required: number) {
    super(`Insufficient funds: available ${available}, required ${required}`);
    this.name = 'InsufficientFundsError';
  }
}
