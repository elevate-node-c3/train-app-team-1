import {
  ErrorCode,
  type SearchOneWayTripsResponse,
  type SearchReturnTripsResponse,
  type TripStopsResponse,
  type ValidationIssueRef,
} from '@app/contracts';
import { CALLER_ACCOUNT_ID_KEY } from '@app/common';
import { RpcException } from '@nestjs/microservices';
import * as grpc from '@grpc/grpc-js';
import { describe, expect, it, vi } from 'vitest';

import { CatalogSearchError } from './catalog-search-error.js';
import { TripsGrpcController } from './trips.grpc.controller.js';
import type { TripReturnSearchService } from './trip-return-search.service.js';
import type { TripSearchService } from './trip-search.service.js';
import type { TripStopsService } from './trip-stops.service.js';

const EMPTY_RESPONSE = {
  dateStrip: [],
  trips: [],
  bookingWindow: {
    firstBookableDate: '2026-06-15',
    lastBookableDate: '2026-07-14',
    totalDays: 30,
  },
  evaluatedAt: {
    localDate: '2026-06-15',
    localTime: '12:00',
    utcOffset: '+03:00',
    iso: '2026-06-15T12:00:00+03:00',
    timeZone: 'Africa/Cairo',
  },
} satisfies SearchOneWayTripsResponse;

const request = {
  originStationId: '11111111-1111-4111-8111-111111111111',
  destinationStationId: '22222222-2222-4222-8222-222222222222',
  departureDate: '2026-06-20',
  travelClassId: '33333333-3333-4333-8333-333333333333',
};

/** The traveller the gateway's metadata would have put in CLS. */
const TRAVELLER = '66666666-6666-4666-8666-666666666666';

function controllerWith(
  search: Partial<TripSearchService>,
  stops: Partial<TripStopsService> = {},
  returnSearch: Partial<TripReturnSearchService> = {},
  caller: Record<string, unknown> = { [CALLER_ACCOUNT_ID_KEY]: TRAVELLER },
) {
  return new TripsGrpcController(
    search as TripSearchService,
    returnSearch as TripReturnSearchService,
    stops as TripStopsService,
    { get: (key: string) => caller[key] } as never,
  );
}

describe('the search gRPC controller', () => {
  it('passes the request through and returns the response', async () => {
    const search = vi.fn().mockResolvedValue(EMPTY_RESPONSE);

    const response = await controllerWith({ search }).searchOneWayTrips(
      request,
    );

    expect(response).toBe(EMPTY_RESPONSE);
    expect(search.mock.calls[0][0]).toBe(request);
  });

  // Capture time once at the transport boundary for a shared, testable request clock.
  it('captures the instant and hands it to the service', async () => {
    const search = vi.fn().mockResolvedValue(EMPTY_RESPONSE);
    const before = Date.now();

    await controllerWith({ search }).searchOneWayTrips(request);

    const now = search.mock.calls[0][1] as Date;
    expect(now).toBeInstanceOf(Date);
    expect(now.getTime()).toBeGreaterThanOrEqual(before);
    expect(now.getTime()).toBeLessThanOrEqual(Date.now());
  });

  /**
   * Only gateway-verified metadata identifies the traveller; no request account field.
   * Unidentified callers still get the same results, without recording.
   */
  describe('the traveller it records for', () => {
    it('passes the caller from metadata to the service', async () => {
      const search = vi.fn().mockResolvedValue(EMPTY_RESPONSE);

      await controllerWith({ search }).searchOneWayTrips(request);

      expect(search.mock.calls[0][2]).toBe(TRAVELLER);
    });

    it('passes null when no caller was forwarded', async () => {
      const search = vi.fn().mockResolvedValue(EMPTY_RESPONSE);

      await controllerWith({ search }, {}, {}, {}).searchOneWayTrips(request);

      expect(search.mock.calls[0][2]).toBeNull();
    });
  });

  describe('a refusal', () => {
    const refusal = new CatalogSearchError(ErrorCode.VALIDATION_ERROR, [
      {
        field: 'to',
        rejectedValue: 'x',
        issueKey: 'ISSUE_SAME_STATION_AS_ORIGIN',
        actionKey: 'ACTION_PICK_DIFFERENT_DESTINATION',
      },
    ]);

    it('becomes INVALID_ARGUMENT', async () => {
      const search = vi.fn().mockRejectedValue(refusal);

      const error = await controllerWith({ search })
        .searchOneWayTrips(request)
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(RpcException);
      const payload = (error as RpcException).getError() as {
        code: number;
      };
      expect(payload.code).toBe(grpc.status.INVALID_ARGUMENT);
    });

    it('carries the business code and the fields in details', async () => {
      const search = vi.fn().mockRejectedValue(refusal);

      const error = (await controllerWith({ search })
        .searchOneWayTrips(request)
        .catch((caught: unknown) => caught)) as RpcException;

      const payload = error.getError() as { details: string };
      const decoded = JSON.parse(payload.details) as {
        code: string;
        details: ValidationIssueRef[];
      };

      expect(decoded.code).toBe(ErrorCode.VALIDATION_ERROR);
      expect(decoded.details[0].field).toBe('to');
      expect(decoded.details).toEqual(refusal.details);
      expect(decoded.details[0]).not.toHaveProperty('issue');
      expect(decoded.details[0]).not.toHaveProperty('action');
    });
  });

  // Unexpected failures map to 500, not client refusals, without leaking details.
  it('leaves an unexpected error alone', async () => {
    const boom = new Error('connection reset');
    const search = vi.fn().mockRejectedValue(boom);

    const error = await controllerWith({ search })
      .searchOneWayTrips(request)
      .catch((caught: unknown) => caught);

    expect(error).toBe(boom);
  });

  describe('the stops RPC', () => {
    const stopsRequest = {
      tripId: '44444444-4444-4444-8444-444444444444',
      originStationId: request.originStationId,
      destinationStationId: request.destinationStationId,
    };

    const stopsResponse = { stops: [] } satisfies TripStopsResponse;

    it('passes the request through and returns the stops', async () => {
      const stops = vi.fn().mockResolvedValue(stopsResponse);

      const response = await controllerWith({}, { stops }).getTripStops(
        stopsRequest,
      );

      expect(response).toBe(stopsResponse);
      // No clock: stops are not a function of `now`.
      expect(stops).toHaveBeenCalledWith(stopsRequest);
    });

    it('turns a not-found refusal into an RpcException with its business code', async () => {
      const refusal = new CatalogSearchError(ErrorCode.RESOURCE_NOT_FOUND, [
        {
          field: 'tripId',
          rejectedValue: stopsRequest.tripId,
          issueKey: 'ISSUE_TRIP_DOES_NOT_SERVE_PAIR',
          actionKey: 'ACTION_PICK_TRIP_FROM_RESULTS',
        },
      ]);
      const stops = vi.fn().mockRejectedValue(refusal);

      const error = (await controllerWith({}, { stops })
        .getTripStops(stopsRequest)
        .catch((caught: unknown) => caught)) as RpcException;

      expect(error).toBeInstanceOf(RpcException);
      const payload = error.getError() as { details: string };
      expect(JSON.parse(payload.details).code).toBe(
        ErrorCode.RESOURCE_NOT_FOUND,
      );
    });
  });

  describe('the return RPC', () => {
    const returnRequest = {
      outboundTripId: '44444444-4444-4444-8444-444444444444',
      outboundOriginStationId: request.originStationId,
      outboundDestinationStationId: request.destinationStationId,
      returnDate: '2026-06-25',
      travelClassId: request.travelClassId,
    };

    const returnResponse = {
      trips: [],
      evaluatedAt: EMPTY_RESPONSE.evaluatedAt,
    } satisfies SearchReturnTripsResponse;

    it('passes the request through and captures the instant', async () => {
      const search = vi.fn().mockResolvedValue(returnResponse);
      const before = Date.now();

      const response = await controllerWith(
        {},
        {},
        { search },
      ).searchReturnTrips(returnRequest);

      expect(response).toBe(returnResponse);
      expect(search.mock.calls[0][0]).toBe(returnRequest);
      const now = search.mock.calls[0][1] as Date;
      expect(now.getTime()).toBeGreaterThanOrEqual(before);
    });

    it('turns a withdrawn outbound trip into a not-found refusal', async () => {
      const refusal = new CatalogSearchError(ErrorCode.RESOURCE_NOT_FOUND, [
        {
          field: 'outboundTripId',
          rejectedValue: returnRequest.outboundTripId,
          issueKey: 'ISSUE_OUTBOUND_TRIP_GONE',
          actionKey: 'ACTION_SEARCH_AGAIN_FOR_OUTBOUND',
        },
      ]);
      const search = vi.fn().mockRejectedValue(refusal);

      const error = (await controllerWith({}, {}, { search })
        .searchReturnTrips(returnRequest)
        .catch((caught: unknown) => caught)) as RpcException;

      const payload = error.getError() as { details: string };
      expect(JSON.parse(payload.details).code).toBe(
        ErrorCode.RESOURCE_NOT_FOUND,
      );
    });
  });
});
