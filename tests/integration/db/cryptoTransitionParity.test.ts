import { CryptoPaymentStatus } from '@prisma/client';
import { prisma } from '@/db/client';
import { TRANSITIONS } from '@/crypto/paymentStateMachine';

/**
 * The crypto payment lifecycle is written three times:
 *
 *   1. TRANSITIONS in src/crypto/paymentStateMachine.ts
 *   2. enforce_crypto_payment_status_transition() in the migration
 *   3. the predicate of CryptoPayment_one_active_per_intent_key
 *
 * The duplication is deliberate — the trigger is what keeps direct SQL and
 * future workers inside the reviewed lifecycle — but drift between the copies is
 * silent and asymmetric. A state added to (1) but not (2) only surfaces as
 * `crypto_payment_invalid_status_transition` under integration tests; a state
 * added to (2) but not (3) quietly permits two concurrent in-flight payments for
 * one intent, which is the single thing that index exists to prevent.
 *
 * This reads all three out of the live database and asserts they still agree.
 */

type Edge = `${CryptoPaymentStatus}->${CryptoPaymentStatus}`;

function edgesFromTypeScript(): Set<Edge> {
  const edges = new Set<Edge>();
  for (const [key, next] of TRANSITIONS) {
    const from = key.split(':')[0] as CryptoPaymentStatus;
    edges.add(`${from}->${next}`);
  }
  return edges;
}

function edgesFromTrigger(source: string): Set<Edge> {
  const edges = new Set<Edge>();
  const clause =
    /OLD\."status" = '([A-Z_]+)'\s+AND NEW\."status" (?:IN \(([^)]*)\)|= '([A-Z_]+)')/g;

  let match = clause.exec(source);
  while (match !== null) {
    const from = match[1] as CryptoPaymentStatus;
    const targets = match[2]
      ? match[2].split(',').map((value) => value.trim().replace(/'/g, ''))
      : [match[3]];
    for (const to of targets) edges.add(`${from}->${to as CryptoPaymentStatus}`);
    match = clause.exec(source);
  }
  return edges;
}

function statusesFromIndexPredicate(indexDef: string): Set<CryptoPaymentStatus> {
  const arrayMatch = /ARRAY\[(.+?)\]/s.exec(indexDef);
  if (!arrayMatch) throw new Error(`Could not parse index predicate: ${indexDef}`);
  return new Set(
    arrayMatch[1]
      .split(',')
      .map((entry) => entry.trim().replace(/::.*/, '').replace(/'/g, '') as CryptoPaymentStatus),
  );
}

const sorted = (values: Iterable<string>) => [...values].sort();

describe('crypto payment lifecycle parity between code and database', () => {
  let triggerSource: string;
  let indexDef: string;

  beforeAll(async () => {
    const [fn] = await prisma.$queryRawUnsafe<{ definition: string }[]>(
      `SELECT pg_get_functiondef(oid) AS definition
         FROM pg_proc
        WHERE proname = 'enforce_crypto_payment_status_transition'`,
    );
    triggerSource = fn.definition;

    const [index] = await prisma.$queryRawUnsafe<{ indexdef: string }[]>(
      `SELECT indexdef FROM pg_indexes
        WHERE indexname = 'CryptoPayment_one_active_per_intent_key'`,
    );
    indexDef = index.indexdef;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('reads a non-empty rule set out of the database', () => {
    expect(triggerSource).toContain('crypto_payment_invalid_status_transition');
    expect(edgesFromTrigger(triggerSource).size).toBeGreaterThan(0);
    expect(indexDef).toContain('CryptoPayment');
  });

  it('permits exactly the same transitions in TypeScript and in the trigger', () => {
    expect(sorted(edgesFromTrigger(triggerSource))).toEqual(sorted(edgesFromTypeScript()));
  });

  it('excludes from the active index exactly the terminal states that moved no funds', () => {
    const withOutgoingEdges = new Set(
      [...TRANSITIONS.keys()].map((key) => key.split(':')[0] as CryptoPaymentStatus),
    );
    const terminal = Object.values(CryptoPaymentStatus).filter(
      (status) => !withOutgoingEdges.has(status),
    );

    // SUCCEEDED is terminal but stays inside the index, so a paid intent is
    // permanently closed. Every other terminal state moved no funds and may be
    // replaced by a new attempt.
    const expectedExclusions = terminal.filter(
      (status) => status !== CryptoPaymentStatus.SUCCEEDED,
    );

    expect(sorted(statusesFromIndexPredicate(indexDef))).toEqual(sorted(expectedExclusions));
    expect(statusesFromIndexPredicate(indexDef).has(CryptoPaymentStatus.SUCCEEDED)).toBe(false);
  });

  it('covers every status the enum declares in exactly one of the two roles', () => {
    const withOutgoingEdges = new Set(
      [...TRANSITIONS.keys()].map((key) => key.split(':')[0] as CryptoPaymentStatus),
    );
    const excluded = statusesFromIndexPredicate(indexDef);

    for (const status of Object.values(CryptoPaymentStatus)) {
      const isNonTerminal = withOutgoingEdges.has(status);
      // A state is either still live (has outgoing edges, held by the index) or
      // terminal; only a terminal state may be excluded from the index.
      expect(isNonTerminal && excluded.has(status)).toBe(false);
    }
  });
});
