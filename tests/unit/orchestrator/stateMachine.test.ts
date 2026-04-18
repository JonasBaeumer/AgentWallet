import { IntentStatus, IntentEvent, IllegalTransitionError } from '@/contracts';
import { getNextStatus, TRANSITION_TABLE, ACTIVE_STATES } from '@/orchestrator/transitions';

describe('getNextStatus - legal transitions', () => {
  const legalCases: [IntentStatus, IntentEvent, IntentStatus][] = [
    [IntentStatus.RECEIVED, IntentEvent.INTENT_CREATED, IntentStatus.SEARCHING],
    [IntentStatus.SEARCHING, IntentEvent.QUOTE_RECEIVED, IntentStatus.QUOTED],
    [IntentStatus.QUOTED, IntentEvent.APPROVAL_REQUESTED, IntentStatus.AWAITING_APPROVAL],
    [IntentStatus.AWAITING_APPROVAL, IntentEvent.USER_APPROVED, IntentStatus.APPROVED],
    [IntentStatus.AWAITING_APPROVAL, IntentEvent.USER_DENIED, IntentStatus.DENIED],
    [IntentStatus.APPROVED, IntentEvent.CARD_ISSUED, IntentStatus.CARD_ISSUED],
    [IntentStatus.CARD_ISSUED, IntentEvent.CHECKOUT_STARTED, IntentStatus.CHECKOUT_RUNNING],
    [IntentStatus.CHECKOUT_RUNNING, IntentEvent.CHECKOUT_SUCCEEDED, IntentStatus.DONE],
    [IntentStatus.CHECKOUT_RUNNING, IntentEvent.CHECKOUT_FAILED, IntentStatus.FAILED],
  ];

  legalCases.forEach(([from, event, expected]) => {
    it(`${from} + ${event} -> ${expected}`, () => {
      expect(getNextStatus(from, event)).toBe(expected);
    });
  });

  it('any active state + INTENT_EXPIRED -> EXPIRED', () => {
    Array.from(ACTIVE_STATES).forEach((status) => {
      expect(getNextStatus(status, IntentEvent.INTENT_EXPIRED)).toBe(IntentStatus.EXPIRED);
    });
  });
});

describe('getNextStatus - illegal transitions', () => {
  it('throws IllegalTransitionError for DONE + USER_APPROVED', () => {
    expect(() => getNextStatus(IntentStatus.DONE, IntentEvent.USER_APPROVED)).toThrow(
      IllegalTransitionError,
    );
  });

  it('throws IllegalTransitionError for RECEIVED + CHECKOUT_SUCCEEDED', () => {
    expect(() => getNextStatus(IntentStatus.RECEIVED, IntentEvent.CHECKOUT_SUCCEEDED)).toThrow(
      IllegalTransitionError,
    );
  });

  it('throws IllegalTransitionError for DENIED + CARD_ISSUED', () => {
    expect(() => getNextStatus(IntentStatus.DENIED, IntentEvent.CARD_ISSUED)).toThrow(
      IllegalTransitionError,
    );
  });

  it('throws IllegalTransitionError for EXPIRED + USER_APPROVED', () => {
    expect(() => getNextStatus(IntentStatus.EXPIRED, IntentEvent.USER_APPROVED)).toThrow(
      IllegalTransitionError,
    );
  });
});

describe('Transition table completeness', () => {
  it('has 9 legal transitions defined', () => {
    expect(TRANSITION_TABLE.size).toBe(9);
  });
});
