import { describe, expect, it, vi } from 'vitest';
import { HttpException, HttpStatus } from '@nestjs/common';
import type { ClsService } from 'nestjs-cls';
import { of, throwError } from 'rxjs';
import { ErrorCode, GRPC_STATUS } from '@app/contracts';

import { BookingGrpcClientService } from './booking.grpc.client.js';
import type { BookingGrpcClient } from './booking.types.js';

const BOOKING_REFERENCE = '70000000-0000-4000-8000-000000000001';

const response = { bookingReference: BOOKING_REFERENCE, state: 'seats_held' };

function clientWith(
  overrides: Partial<Record<keyof BookingGrpcClient, unknown>>,
): { service: BookingGrpcClientService; client: BookingGrpcClient } {
  const client = {
    submitBooking: vi.fn(() => of(response)),
    acceptTerms: vi.fn(() => of(response)),
    continueToPayment: vi.fn(() => of(response)),
    abandonBooking: vi.fn(() => of(response)),
    getBooking: vi.fn(() => of(response)),
    ...overrides,
  } as unknown as BookingGrpcClient;
  // Only the correlation id is set; roles and the rest stay absent.
  const cls = {
    get: vi.fn((key: string) => (key === 'correlationId' ? 'corr-1' : undefined)),
  } as unknown as ClsService;

  return { service: new BookingGrpcClientService(client, cls), client };
}

/** A refusal as booking sends it: a code and its field refs, with no text. */
function refusal(code: ErrorCode, details: unknown[] = []) {
  return Object.assign(new Error(code), {
    code: GRPC_STATUS.FAILED_PRECONDITION,
    details: JSON.stringify({ code, ...(details.length ? { details } : {}) }),
  });
}

describe('BookingGrpcClientService', () => {
  it('carries a deadline on every call', async () => {
    const { service, client } = clientWith({});

    await service.get({ bookingReference: BOOKING_REFERENCE });

    const options = vi.mocked(client.getBooking).mock.calls[0][2];
    expect(options?.deadline).toBeGreaterThan(Date.now());
  });

  it.each([
    ['acceptTerms', 'acceptTerms'],
    ['continueToPayment', 'continueToPayment'],
    ['abandon', 'abandonBooking'],
    ['get', 'getBooking'],
  ] as const)('sends %s by booking reference alone', async (method, rpc) => {
    const { service, client } = clientWith({});

    await service[method]({ bookingReference: BOOKING_REFERENCE });

    expect(client[rpc]).toHaveBeenCalledWith(
      { bookingReference: BOOKING_REFERENCE },
      expect.anything(),
      expect.objectContaining({ deadline: expect.any(Number) }),
    );
  });

  it('keeps the business code and its refs on a refusal', async () => {
    const details = [
      {
        field: 'terms',
        rejectedValue: undefined,
        issueKey: 'ISSUE_VALIDATION_FAILED',
      },
    ];
    const { service } = clientWith({
      continueToPayment: vi.fn(() =>
        throwError(() => refusal(ErrorCode.TERMS_REQUIRED, details)),
      ),
    });

    const error = await service
      .continueToPayment({ bookingReference: BOOKING_REFERENCE })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).getStatus()).toBe(
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
    expect((error as HttpException).getResponse()).toEqual({
      code: ErrorCode.TERMS_REQUIRED,
      message: details,
    });
  });

  it('falls back to the transport status when there is no refusal', async () => {
    const { service } = clientWith({
      getBooking: vi.fn(() =>
        throwError(() =>
          Object.assign(new Error('transport down'), {
            code: GRPC_STATUS.UNAVAILABLE,
          }),
        ),
      ),
    });

    const error = await service
      .get({ bookingReference: BOOKING_REFERENCE })
      .catch((caught: unknown) => caught);

    expect((error as HttpException).getStatus()).toBe(
      HttpStatus.SERVICE_UNAVAILABLE,
    );
  });

  it('never forwards an unrecognised detail payload to a caller', async () => {
    const { service } = clientWith({
      getBooking: vi.fn(() =>
        throwError(() =>
          Object.assign(new Error('boom'), {
            code: GRPC_STATUS.INTERNAL,
            details: 'select * from booking_draft where id = $1',
          }),
        ),
      ),
    });

    const error = await service
      .get({ bookingReference: BOOKING_REFERENCE })
      .catch((caught: unknown) => caught);

    expect((error as HttpException).getStatus()).toBe(
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
    expect(JSON.stringify((error as HttpException).getResponse())).not.toContain(
      'booking_draft',
    );
  });
});
