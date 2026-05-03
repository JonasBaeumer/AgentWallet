/**
 * Module-local cache for PAN/CVV of Privacy.com cards.
 *
 * Why this exists: Privacy.com returns `pan` and `cvv` only on the create
 * response — there's no server-side retrieval path. Our two-step flow
 * (issueCard then, later, revealCard) requires us to hold those values
 * somewhere between the two calls.
 *
 * The cache is intentionally in process memory only:
 *  - never persisted to the DB (PCI scope)
 *  - never serialized to logs
 *  - entries expire after a short TTL or on first reveal (whichever first)
 *
 * Consequence: if the server restarts between issueCard and revealCard, the
 * agent cannot retrieve the card — the intent must be expired and re-issued.
 * This is acceptable for v0.1; a production deployment would want a
 * PCI-scoped secret store (e.g. encrypted Redis entry with a KMS-wrapped key).
 */
import { CardReveal } from '@/contracts';

const TTL_MS = 10 * 60 * 1000; // 10 minutes
const entries = new Map<string, { reveal: CardReveal; expiresAt: number }>();

export function store(intentId: string, reveal: CardReveal): void {
  entries.set(intentId, { reveal, expiresAt: Date.now() + TTL_MS });
}

export function takeOnce(intentId: string): CardReveal | null {
  const entry = entries.get(intentId);
  if (!entry) return null;
  entries.delete(intentId);
  if (entry.expiresAt < Date.now()) return null;
  return entry.reveal;
}

/** Test-only: clear all cached entries. */
export function clearAll(): void {
  entries.clear();
}
