import { describe, expect, it } from 'vitest';
import { RpcException } from '@nestjs/microservices';
import * as grpc from '@grpc/grpc-js';
import { createGrpcValidationPipe, decodeRefusal } from '@app/common';
import { ErrorCode, type ValidationIssueRef } from '@app/contracts';

import {
  CancelChargeRequestDto,
  StartChargeRequestDto,
} from './charge-request.dto.js';

const pipe = createGrpcValidationPipe();
const BOOKING_REFERENCE = '40000000-0000-4000-8000-000000000001';
const PAYMENT_REFERENCE = '41000000-0000-4000-8000-000000000001';

function startRequest(overrides: Record<string, unknown> = {}) {
  return {
    bookingReference: BOOKING_REFERENCE,
    amountPiastres: 12_500,
    currency: 'EGP',
    idempotencyKey: 'charge-key-1',
    accountId: '42000000-0000-4000-8000-000000000001',
    ...overrides,
  };
}

async function refuse(
  value: unknown,
  metatype: unknown = StartChargeRequestDto,
): Promise<ValidationIssueRef[]> {
  try {
    await pipe.transform(value, { type: 'body', metatype: metatype as never });
  } catch (error: unknown) {
    expect((error as RpcException).getError()).toMatchObject({
      code: grpc.status.INVALID_ARGUMENT,
    });
    const refusal = decodeRefusal(error);
    expect(refusal?.code).toBe(ErrorCode.VALIDATION_ERROR);
    return refusal?.details ?? [];
  }

  throw new Error('Expected the request to be refused.');
}

function issueKeys(details: ValidationIssueRef[]): string[] {
  return details.map((detail) => detail.issueKey);
}

describe('charge request DTOs', () => {
  it('accepts a well-formed charge', async () => {
    const value = await pipe.transform(startRequest(), {
      type: 'body',
      metatype: StartChargeRequestDto as never,
    });

    expect(value).toBeInstanceOf(StartChargeRequestDto);
    expect(value.amountPiastres).toBe(12_500);
  });

  it('refuses a currency the charge table would reject', async () => {
    // payment_charge has CHECK (currency = 'EGP').
    const details = await refuse(startRequest({ currency: 'USD' }));

    expect(details).toEqual([
      {
        field: 'currency',
        rejectedValue: 'USD',
        issueKey: 'ISSUE_NOT_AN_ALLOWED_VALUE',
      },
    ]);
  });

  it.each([
    ['zero', 0],
    ['negative', -1],
  ])('refuses a %s amount, which CHECK forbids', async (_name, amount) => {
    const details = await refuse(startRequest({ amountPiastres: amount }));

    expect(issueKeys(details)).toEqual(['ISSUE_BELOW_MINIMUM']);
  });

  it('refuses a fraction of a piastre', async () => {
    const details = await refuse(startRequest({ amountPiastres: 10.5 }));

    expect(issueKeys(details)).toEqual(['ISSUE_MUST_BE_WHOLE_NUMBER']);
  });

  it('refuses a booking reference a uuid column could not store', async () => {
    const details = await refuse(
      startRequest({ bookingReference: 'booking-1' }),
    );

    expect(issueKeys(details)).toEqual(['ISSUE_MUST_BE_UUID']);
  });

  it('refuses a missing idempotency key, which a retry depends on', async () => {
    const details = await refuse(startRequest({ idempotencyKey: '' }));

    expect(issueKeys(details)).toEqual(['ISSUE_REQUIRED']);
  });

  it('refuses a field payment.proto does not define', async () => {
    const details = await refuse(startRequest({ cardNumber: '4242' }));

    expect(details).toEqual([
      {
        field: 'cardNumber',
        rejectedValue: '4242',
        issueKey: 'ISSUE_UNKNOWN_FIELD',
      },
    ]);
  });

  it('accepts a cancellation, and refuses one without a charge to cancel', async () => {
    const value = await pipe.transform(
      {
        bookingReference: BOOKING_REFERENCE,
        paymentReference: PAYMENT_REFERENCE,
        idempotencyKey: 'cancel-key-1',
      },
      { type: 'body', metatype: CancelChargeRequestDto as never },
    );
    expect(value).toBeInstanceOf(CancelChargeRequestDto);

    const details = await refuse(
      {
        bookingReference: BOOKING_REFERENCE,
        paymentReference: 'not-a-reference',
        idempotencyKey: 'cancel-key-1',
      },
      CancelChargeRequestDto,
    );
    expect(issueKeys(details)).toEqual(['ISSUE_MUST_BE_UUID']);
  });
});
