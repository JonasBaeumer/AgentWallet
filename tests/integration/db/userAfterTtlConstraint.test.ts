/**
 * Integration test: Postgres CHECK constraint enforcing the
 * AFTER_TTL ↔ cardTtlMinutes invariant on the User table.
 *
 * Defense-in-depth for issue #143 / follow-up to #89 / PR #136.
 * The application layer already prevents this broken state, but this test
 * pins the database-level guard so any future code path that writes the
 * broken state directly is rejected at write time.
 *
 * Requires running Postgres (docker compose up -d) with migrations applied.
 *
 * Run: npm run test:integration -- --testPathPattern=userAfterTtlConstraint
 */

import { prisma } from '@/db/client';
import { CardCancelPolicy } from '@/contracts';

const CONSTRAINT_NAME = 'user_after_ttl_requires_cardttlminutes';

const createdUserIds: string[] = [];

async function createUser(overrides: {
  cancelPolicy?: CardCancelPolicy;
  cardTtlMinutes?: number | null;
}) {
  const user = await prisma.user.create({
    data: {
      email: `after-ttl-check-${Date.now()}-${Math.random().toString(36).slice(2)}@test.local`,
      cancelPolicy: overrides.cancelPolicy ?? CardCancelPolicy.ON_TRANSACTION,
      cardTtlMinutes: overrides.cardTtlMinutes ?? null,
    },
  });
  createdUserIds.push(user.id);
  return user;
}

async function expectConstraintViolation(promise: Promise<unknown>) {
  await expect(promise).rejects.toMatchObject({
    message: expect.stringContaining(CONSTRAINT_NAME),
  });
}

afterAll(async () => {
  if (createdUserIds.length) {
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  }
  await prisma.$disconnect();
});

describe('User AFTER_TTL ↔ cardTtlMinutes CHECK constraint', () => {
  describe('rejects broken states', () => {
    it('rejects update that switches to AFTER_TTL while cardTtlMinutes is null', async () => {
      const user = await createUser({
        cancelPolicy: CardCancelPolicy.ON_TRANSACTION,
        cardTtlMinutes: null,
      });

      await expectConstraintViolation(
        prisma.user.update({
          where: { id: user.id },
          data: { cancelPolicy: CardCancelPolicy.AFTER_TTL, cardTtlMinutes: null },
        }),
      );
    });

    it('rejects update that clears cardTtlMinutes on an AFTER_TTL user', async () => {
      const user = await createUser({
        cancelPolicy: CardCancelPolicy.AFTER_TTL,
        cardTtlMinutes: 60,
      });

      await expectConstraintViolation(
        prisma.user.update({
          where: { id: user.id },
          data: { cardTtlMinutes: null },
        }),
      );
    });

    it('rejects update that sets cardTtlMinutes to 0 on an AFTER_TTL user', async () => {
      const user = await createUser({
        cancelPolicy: CardCancelPolicy.AFTER_TTL,
        cardTtlMinutes: 60,
      });

      await expectConstraintViolation(
        prisma.user.update({
          where: { id: user.id },
          data: { cardTtlMinutes: 0 },
        }),
      );
    });

    it('rejects create with AFTER_TTL and null cardTtlMinutes', async () => {
      await expectConstraintViolation(
        prisma.user.create({
          data: {
            email: `after-ttl-create-${Date.now()}@test.local`,
            cancelPolicy: CardCancelPolicy.AFTER_TTL,
            cardTtlMinutes: null,
          },
        }),
      );
    });

    it('rejects create with AFTER_TTL and cardTtlMinutes set to 0', async () => {
      await expectConstraintViolation(
        prisma.user.create({
          data: {
            email: `after-ttl-create-zero-${Date.now()}@test.local`,
            cancelPolicy: CardCancelPolicy.AFTER_TTL,
            cardTtlMinutes: 0,
          },
        }),
      );
    });
  });

  describe('accepts valid states', () => {
    it('allows AFTER_TTL with positive cardTtlMinutes', async () => {
      const user = await createUser({
        cancelPolicy: CardCancelPolicy.AFTER_TTL,
        cardTtlMinutes: 30,
      });
      expect(user.cancelPolicy).toBe(CardCancelPolicy.AFTER_TTL);
      expect(user.cardTtlMinutes).toBe(30);
    });

    it('allows non-AFTER_TTL policies with null cardTtlMinutes', async () => {
      for (const policy of [
        CardCancelPolicy.ON_TRANSACTION,
        CardCancelPolicy.IMMEDIATE,
        CardCancelPolicy.MANUAL,
      ]) {
        const user = await createUser({ cancelPolicy: policy, cardTtlMinutes: null });
        expect(user.cancelPolicy).toBe(policy);
        expect(user.cardTtlMinutes).toBeNull();
      }
    });

    it('allows switching from AFTER_TTL back to a policy with null cardTtlMinutes in a single update', async () => {
      const user = await createUser({
        cancelPolicy: CardCancelPolicy.AFTER_TTL,
        cardTtlMinutes: 45,
      });

      const updated = await prisma.user.update({
        where: { id: user.id },
        data: { cancelPolicy: CardCancelPolicy.ON_TRANSACTION, cardTtlMinutes: null },
      });

      expect(updated.cancelPolicy).toBe(CardCancelPolicy.ON_TRANSACTION);
      expect(updated.cardTtlMinutes).toBeNull();
    });

    it('allows switching to AFTER_TTL with a positive cardTtlMinutes in a single update', async () => {
      const user = await createUser({
        cancelPolicy: CardCancelPolicy.ON_TRANSACTION,
        cardTtlMinutes: null,
      });

      const updated = await prisma.user.update({
        where: { id: user.id },
        data: { cancelPolicy: CardCancelPolicy.AFTER_TTL, cardTtlMinutes: 30 },
      });

      expect(updated.cancelPolicy).toBe(CardCancelPolicy.AFTER_TTL);
      expect(updated.cardTtlMinutes).toBe(30);
    });
  });
});
