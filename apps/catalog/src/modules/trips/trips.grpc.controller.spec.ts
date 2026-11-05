import { ErrorCode, type SearchOneWayTripsResponse } from '@app/contracts';
import { RpcException } from '@nestjs/microservices';
import * as grpc from '@grpc/grpc-js';
import { describe, expect, it, vi } from 'vitest';

import { CatalogSearchError } from './catalog-search-error.js';
import { TripsGrpcController } from './trips.grpc.controller.js';
import type { TripSearchService } from './trip-search.service.js';

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

function controllerWith(search: Partial<TripSearchService>) {
  return new TripsGrpcController(search as TripSearchService);
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

  // The service cannot call new Date() itself and still be testable against a
  // frozen clock, so the transport supplies the instant -- once.
  it('captures the instant and hands it to the service', async () => {
    const search = vi.fn().mockResolvedValue(EMPTY_RESPONSE);
    const before = Date.now();

    await controllerWith({ search }).searchOneWayTrips(request);

    const now = search.mock.calls[0][1] as Date;
    expect(now).toBeInstanceOf(Date);
    expect(now.getTime()).toBeGreaterThanOrEqual(before);
    expect(now.getTime()).toBeLessThanOrEqual(Date.now());
  });

  describe('a refusal', () => {
    const refusal = new CatalogSearchError(
      ErrorCode.VALIDATION_ERROR,
      [
        {
          field: 'to',
          rejectedValue: 'x',
          issue: 'is the same station as From',
          action: 'Pick a different destination station',
        },
      ],
    );

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
        details: { field: string; action: string }[];
      };

      expect(decoded.code).toBe(ErrorCode.VALIDATION_ERROR);
      expect(decoded.details[0].field).toBe('to');
      expect(decoded.details[0].action).not.toBe('');
    });
  });

  // An unexpected failure must not be dressed up as a client mistake: the
  // gateway maps an unknown status to 500 and says nothing about it.
  it('leaves an unexpected error alone', async () => {
    const boom = new Error('connection reset');
    const search = vi.fn().mockRejectedValue(boom);

    const error = await controllerWith({ search })
      .searchOneWayTrips(request)
      .catch((caught: unknown) => caught);

    expect(error).toBe(boom);
  });
});
