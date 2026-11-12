import { ErrorCode } from '@app/contracts';
import type { SearchOneWayTripsResponse } from '@app/contracts';
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

/**
 * Typed, not `as never`: rxjs declares an `of(value: null)` overload, and
 * `never` is assignable to `null`, so an untyped stub made `of(RESPONSE)` an
 * `Observable<null>` that no longer matched the client's own signature.
 */
const RESPONSE: SearchOneWayTripsResponse = {
  dateStrip: [],
  trips: [],
  bookingWindow: {
    firstBookableDate: '2026-06-20',
    lastBookableDate: '2026-07-19',
    totalDays: 30,
  },
  evaluatedAt: {
    localDate: '2026-06-20',
    localTime: '09:00',
    utcOffset: '+03:00',
    iso: '2026-06-20T06:00:00.000Z',
    timeZone: 'Africa/Cairo',
  },
};

function clientWith(
  searchOneWayTrips: CatalogGrpcClient['searchOneWayTrips'],
): CatalogGrpcClientService {
  const cls = { get: () => undefined, set: () => undefined } as unknown as ClsService;
  // Only the one method: these specs call only `searchOneWayTrips`, and a stub
  // for the other three would suggest they are exercised here.
  return new CatalogGrpcClientService(
    { searchOneWayTrips } as CatalogGrpcClient,
    cls,
  );
}

/** A client with every method stubbed by one factory, for the shared-path specs. */
function clientForAll(
  stub: (name: string) => (...args: unknown[]) => Observable<unknown>,
): CatalogGrpcClientService {
  const cls = {
    get: () => undefined,
    set: () => undefined,
  } as unknown as ClsService;

  return new CatalogGrpcClientService(
    {
      searchOneWayTrips: stub('searchOneWayTrips'),
      searchReturnTrips: stub('searchReturnTrips'),
      getTripStops: stub('getTripStops'),
      listRecentSearches: stub('listRecentSearches'),
    } as unknown as CatalogGrpcClient,
    cls,
  );
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

/**
 * Every method goes through one private `call`, so the deadline and the error
 * mapping cannot be forgotten on a new one. These specs are about that shared
 * path rather than about any single RPC.
 */
describe('every catalog call', () => {
  const invoke = (
    service: CatalogGrpcClientService,
    name: string,
  ): Promise<unknown> =>
    ({
      searchOneWayTrips: () => service.searchOneWayTrips(request),
      searchReturnTrips: () =>
        service.searchReturnTrips({
          outboundTripId: '44444444-4444-4444-8444-444444444444',
          outboundOriginStationId: request.originStationId,
          outboundDestinationStationId: request.destinationStationId,
          returnDate: '2026-06-25',
          travelClassId: request.travelClassId,
        }),
      getTripStops: () =>
        service.getTripStops({
          tripId: '44444444-4444-4444-8444-444444444444',
          originStationId: request.originStationId,
          destinationStationId: request.destinationStationId,
        }),
      listRecentSearches: () => service.listRecentSearches({}),
    })[name]!();

  const METHODS = [
    'searchOneWayTrips',
    'searchReturnTrips',
    'getTripStops',
    'listRecentSearches',
  ] as const;

  it.each(METHODS)('carries a deadline on %s', async (name) => {
    const seen: CallOptions[] = [];
    const service = clientForAll(
      () => (_data, _metadata, options) => {
        seen.push(options as CallOptions);
        return of({});
      },
    );
    const before = Date.now();

    await invoke(service, name);

    const deadline = seen[0].deadline as number;
    expect(deadline).toBeGreaterThanOrEqual(before);
    expect(deadline).toBeLessThanOrEqual(
      Date.now() + CATALOG_SEARCH_TIMEOUT_MS,
    );
  });

  it.each(METHODS)('maps an unavailable catalog to 503 on %s', async (name) => {
    const service = clientForAll(() => () => throwError(() => ({ code: 14 })));

    const error = (await invoke(service, name).catch(
      (caught: unknown) => caught,
    )) as HttpException;

    expect(error.getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
  });

  it.each(METHODS)('maps a deadline to 504 on %s', async (name) => {
    const service = clientForAll(() => () => throwError(() => ({ code: 4 })));

    const error = (await invoke(service, name).catch(
      (caught: unknown) => caught,
    )) as HttpException;

    expect(error.getStatus()).toBe(HttpStatus.GATEWAY_TIMEOUT);
  });

  // A refusal from catalog keeps its business code whichever call produced it.
  it.each(METHODS)('restores a business refusal on %s', async (name) => {
    const service = clientForAll(
      () => () =>
        throwError(() => ({
          code: 3,
          details: JSON.stringify({
            code: ErrorCode.RESOURCE_NOT_FOUND,
            details: [{ field: 'tripId' }],
          }),
        })),
    );

    const error = (await invoke(service, name).catch(
      (caught: unknown) => caught,
    )) as HttpException;

    expect(error.getStatus()).toBe(HttpStatus.NOT_FOUND);
    expect((error.getResponse() as { code: string }).code).toBe(
      ErrorCode.RESOURCE_NOT_FOUND,
    );
  });
});
