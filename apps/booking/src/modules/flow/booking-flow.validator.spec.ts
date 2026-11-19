import { describe, expect, it } from 'vitest';
import { ErrorCode, type SubmitBookingRequest } from '@app/contracts';

import { BookingFlowError } from './booking-flow-error.js';
import {
  isSameSubmission,
  validateSubmit,
} from './booking-flow.validator.js';

const CLASS = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OUTBOUND = {
  tripId: '11111111-1111-4111-8111-111111111111',
  originStationId: '22222222-2222-4222-8222-222222222222',
  destinationStationId: '33333333-3333-4333-8333-333333333333',
};
const INBOUND = {
  tripId: '44444444-4444-4444-8444-444444444444',
  originStationId: OUTBOUND.destinationStationId,
  destinationStationId: OUTBOUND.originStationId,
};

function submission(
  overrides: Partial<SubmitBookingRequest> = {},
): SubmitBookingRequest {
  return {
    idempotencyKey: 'key-1',
    travelClassId: CLASS,
    legs: [OUTBOUND],
    passengerIds: ['p1'],
    ...overrides,
  };
}

function codeOf(run: () => void): ErrorCode {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(BookingFlowError);
    return (error as BookingFlowError).code;
  }
  throw new Error('Expected a refusal.');
}

describe('validateSubmit', () => {
  it('accepts one leg and one passenger', () => {
    expect(() => validateSubmit(submission())).not.toThrow();
  });

  it('accepts a round trip for four passengers', () => {
    expect(() =>
      validateSubmit(
        submission({ legs: [OUTBOUND, INBOUND], passengerIds: ['a', 'b', 'c', 'd'] }),
      ),
    ).not.toThrow();
  });

  it('names the missing idempotency key', () => {
    const error = codeOf(() =>
      validateSubmit(submission({ idempotencyKey: '' })),
    );
    expect(error).toBe(ErrorCode.VALIDATION_ERROR);
  });

  it('names the missing travel class', () => {
    expect(codeOf(() => validateSubmit(submission({ travelClassId: '' })))).toBe(
      ErrorCode.VALIDATION_ERROR,
    );
  });

  it('refuses no legs and more than two', () => {
    expect(codeOf(() => validateSubmit(submission({ legs: [] })))).toBe(
      ErrorCode.VALIDATION_ERROR,
    );
    expect(
      codeOf(() =>
        validateSubmit(submission({ legs: [OUTBOUND, INBOUND, OUTBOUND] })),
      ),
    ).toBe(ErrorCode.VALIDATION_ERROR);
  });

  it('refuses an empty passenger list', () => {
    expect(codeOf(() => validateSubmit(submission({ passengerIds: [] })))).toBe(
      ErrorCode.PASSENGERS_REQUIRED,
    );
  });

  it('refuses a fifth passenger (BR-28)', () => {
    expect(
      codeOf(() =>
        validateSubmit(submission({ passengerIds: ['a', 'b', 'c', 'd', 'e'] })),
      ),
    ).toBe(ErrorCode.TOO_MANY_PASSENGERS);
  });

  it('refuses the same passenger twice', () => {
    expect(
      codeOf(() => validateSubmit(submission({ passengerIds: ['a', 'a'] }))),
    ).toBe(ErrorCode.DUPLICATE_PASSENGER);
  });

  it('carries the offending field so the client can point at it', () => {
    try {
      validateSubmit(submission({ legs: [] }));
    } catch (error) {
      expect((error as BookingFlowError).details[0]).toMatchObject({
        field: 'legs',
      });
    }
  });
});

describe('isSameSubmission', () => {
  const stored = {
    travelClassId: CLASS,
    bookingLegs: [{ tripId: OUTBOUND.tripId }],
    holdIntent: { passengerRefs: ['p1'] },
  };

  it('recognises the retry of a submission it already made', () => {
    expect(isSameSubmission(stored, submission())).toBe(true);
  });

  it('rejects a key reused for another class', () => {
    expect(
      isSameSubmission(stored, submission({ travelClassId: 'other' })),
    ).toBe(false);
  });

  it('rejects a key reused for other legs', () => {
    expect(isSameSubmission(stored, submission({ legs: [INBOUND] }))).toBe(
      false,
    );
  });

  it('rejects a key reused for other passengers', () => {
    expect(
      isSameSubmission(stored, submission({ passengerIds: ['p2'] })),
    ).toBe(false);
  });

  it('treats passenger order as part of the submission', () => {
    const twoStored = {
      ...stored,
      holdIntent: { passengerRefs: ['p1', 'p2'] },
    };
    expect(
      isSameSubmission(twoStored, submission({ passengerIds: ['p2', 'p1'] })),
    ).toBe(false);
  });
});
