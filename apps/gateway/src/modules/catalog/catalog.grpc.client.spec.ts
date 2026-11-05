import { ErrorCode } from '@app/contracts';
import type { CallOptions } from '@grpc/grpc-js';
import { HttpException, HttpStatus } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { Observable, of, throwError } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';

import {
  CATALOG_SEARCH_TIMEOUT_MS,
  CatalogGrpcClientService,
} from './catalog.grpc.client.js';
import type { CatalogGrpcClient } from './catalog.types.js';

const request = {
  originStationId: '11111111-1111-4111-8111-111111111111',
  destinationStationId: '22222222-2222-4222-8222-222222222222',
  departureDate: '2026-06-20',
  travelClassId: '33333333-3333-4333-8333-333333333333',
};

const RESPONSE = { dateStrip: [], trips: [] } as never;

function clientWith(
  searchOneWayTrips: CatalogGrpcClient['searchOneWayTrips'],
): CatalogGrpcClientService {
  const cls = { get: () => undefined, set: () => undefined } as unknown as ClsService;
  return new CatalogGrpcClientService({ searchOneWayTrips }, cls);
}

describe('calling catalog over gRPC', () => {
  it('returns the response on success', async () => {
    const service = clientWith(() => of(RESPONSE));

    await expect(service.searchOneWayTrips(request)).resolves.toBe(RESPONSE);
  });

  /**
   * The point is not the number, it is that there is one: a slow or stopped
   * catalog has to produce a retryable error rather than a request that never
   * returns.
   */
  it('sends a deadline with every call', async () => {
    const spy = vi.fn().mockReturnValue(of(RESPONSE));
    const before = Date.now();

    await clientWith(spy as never).searchOneWayTrips(request);

    const options = spy.mock.calls[0][2] as CallOptions;
    expect(options.deadline).toBeGreaterThanOrEqual(
      before + CATALOG_SEARCH_TIMEOUT_MS,
    );
    expect(options.deadline).toBeLessThanOrEqual(
      Date.now() + CATALOG_SEARCH_TIMEOUT_MS,
    );
  });

  /**
   * A channel that never produces a deadline event is the case the rxjs
   * timeout exists for, so the belt-and-braces is not redundant. The spec's
   * own timeout is shorter than the runner's default, so a regression here
   * fails rather than stalls the suite.
   */
  it(
    'gives up on a call that never answers, instead of hanging',
    async () => {
      // Never emits, never errors -- exactly a stopped catalog holding the
      // connection open.
      const service = clientWith(() => new Observable<never>(() => {}));

      const error = await service
        .searchOneWayTrips(request)
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(HttpException);
      const exception = error as HttpException;
      expect(exception.getStatus()).toBe(HttpStatus.GATEWAY_TIMEOUT);
      const body = exception.getResponse() as {
        code: string;
        retryAfterSeconds?: number;
      };
      expect(body.code).toBe(ErrorCode.GATEWAY_TIMEOUT);
      // The traveller is told to try again, not just that it failed.
      expect(body.retryAfterSeconds).toBeGreaterThan(0);
    },
    CATALOG_SEARCH_TIMEOUT_MS + 2000,
  );

  describe('a transport failure', () => {
    it('maps a stopped catalog to 503 with a retry hint', async () => {
      // UNAVAILABLE.
      const service = clientWith(() => throwError(() => ({ code: 14 })));

      const error = (await service
        .searchOneWayTrips(request)
        .catch((caught: unknown) => caught)) as HttpException;

      expect(error.getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
      const body = error.getResponse() as {
        code: string;
        retryAfterSeconds?: number;
      };
      expect(body.code).toBe(ErrorCode.SERVICE_UNAVAILABLE);
      expect(body.retryAfterSeconds).toBeGreaterThan(0);
    });

    it('maps a server-side deadline to 504', async () => {
      // DEADLINE_EXCEEDED, as the channel reports it.
      const service = clientWith(() => throwError(() => ({ code: 4 })));

      const error = (await service
        .searchOneWayTrips(request)
        .catch((caught: unknown) => caught)) as HttpException;

      expect(error.getStatus()).toBe(HttpStatus.GATEWAY_TIMEOUT);
    });
  });

  describe('a business refusal', () => {
    it('becomes the status its code maps to, with the fields intact', async () => {
      const service = clientWith(() =>
        throwError(() => ({
          code: 3, // INVALID_ARGUMENT
          details: JSON.stringify({
            code: ErrorCode.VALIDATION_ERROR,
            details: [
              {
                field: 'to',
                rejectedValue: 'x',
                issue: 'is the same station as From',
                action: 'Pick a different destination station',
              },
            ],
          }),
        })),
      );

      const error = (await service
        .searchOneWayTrips(request)
        .catch((caught: unknown) => caught)) as HttpException;

      expect(error.getStatus()).toBe(HttpStatus.BAD_REQUEST);
      const body = error.getResponse() as {
        code: string;
        // Under `message`, because that is the channel the envelope filter
        // reads when turning an exception into error.details.
        message: { field: string }[];
      };
      expect(body.code).toBe(ErrorCode.VALIDATION_ERROR);
      expect(body.message[0].field).toBe('to');
    });

    // The no-leak rule: an unrecognised code is not forwarded, and the call
    // falls back to what the transport status says.
    it('ignores an unknown code and uses the transport status', async () => {
      const service = clientWith(() =>
        throwError(() => ({
          code: 14,
          details: JSON.stringify({ code: 'INVENTED_CODE' }),
        })),
      );

      const error = (await service
        .searchOneWayTrips(request)
        .catch((caught: unknown) => caught)) as HttpException;

      expect(error.getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
      const body = error.getResponse() as { code: string };
      expect(body.code).toBe(ErrorCode.SERVICE_UNAVAILABLE);
    });
  });
});
