import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { EventEnvelope } from '@app/contracts';
import { AllocationOutcome, EVENT_TYPES } from '@app/contracts';
import type { CacheAsideService } from '@app/common';

import { buildFareChanged } from '../operations/fare-events.factory.js';
import type { RouteVersionService } from '../cache/route-version.service.js';
import type { StationsService } from '../stations/services/stations.service.js';
import type { TripStopsService } from '../trips/services/trip-stops.service.js';
import { CacheInvalidationConsumer } from './cache-invalidation.consumer.js';

describe('CacheInvalidationConsumer', () => {
  const mockRouteVersion = {
    incrementRouteVersion: vi.fn().mockResolvedValue(2),
  } as unknown as RouteVersionService;

  const mockStations = {
    invalidate: vi.fn().mockResolvedValue(undefined),
  } as unknown as StationsService;

  const mockTripStops = {
    invalidate: vi.fn().mockResolvedValue(undefined),
  } as unknown as TripStopsService;

  const consumer = new CacheInvalidationConsumer(
    mockRouteVersion,
    mockStations,
    mockTripStops,
  );

  it('increments route version when a fare changes', async () => {
    const envelope: EventEnvelope = {
      id: '11111111-1111-4111-8111-111111111111',
      type: EVENT_TYPES.fareChanged,
      version: 1,
      occurredAt: new Date().toISOString(),
      correlationId: 'corr-1',
      producer: 'ops',
      payload: {
        originStationId: 'sta-cairo',
        destinationStationId: 'sta-alex',
        travelClassId: 'cls-first',
        newAmountPiastres: 14500,
      },
    };

    const res = await consumer.handle(envelope);
    expect(res.status).toBe('handled');
    expect(mockRouteVersion.incrementRouteVersion).toHaveBeenCalledWith(
      'sta-cairo',
      'sta-alex',
    );
  });

  it('bumps the route version for a FareChanged envelope built by the new factory', async () => {
    const envelope = buildFareChanged({
      eventId: randomUUID(),
      correlationId: 'corr-fare-change',
      occurredAt: new Date(),
      payload: {
        originStationId: 'sta-cairo',
        destinationStationId: 'sta-alexandria',
        travelClassId: 'cls-first-ac',
        trainId: 'train-916',
        newAmountPiastres: 20_000,
        effectiveFrom: new Date().toISOString(),
      },
    });

    const res = await consumer.handle(envelope);

    expect(res.status).toBe('handled');
    expect(mockRouteVersion.incrementRouteVersion).toHaveBeenCalledWith(
      'sta-cairo',
      'sta-alexandria',
    );
  });

  it('increments route version and invalidates trip stops when a timetable is published', async () => {
    const envelope: EventEnvelope = {
      id: '22222222-2222-4222-8222-222222222222',
      type: EVENT_TYPES.timetablePublished,
      version: 1,
      occurredAt: new Date().toISOString(),
      correlationId: 'corr-2',
      producer: 'ops',
      payload: {
        timetableId: 'tt-1',
        tripId: 'trip-905',
        originStationId: 'sta-cairo',
        destinationStationId: 'sta-alex',
      },
    };

    const res = await consumer.handle(envelope);
    expect(res.status).toBe('handled');
    expect(mockRouteVersion.incrementRouteVersion).toHaveBeenCalledWith(
      'sta-cairo',
      'sta-alex',
    );
    expect(mockTripStops.invalidate).toHaveBeenCalledWith(
      'trip-905',
      'sta-cairo',
      'sta-alex',
    );
  });

  it('invalidates cached stations when a station changes', async () => {
    const envelope: EventEnvelope = {
      id: '33333333-3333-4333-8333-333333333333',
      type: EVENT_TYPES.stationChanged,
      version: 1,
      occurredAt: new Date().toISOString(),
      correlationId: 'corr-3',
      producer: 'catalog',
      payload: {
        stationId: 'sta-tanta',
        action: 'updated',
      },
    };

    const res = await consumer.handle(envelope);
    expect(res.status).toBe('handled');
    expect(mockStations.invalidate).toHaveBeenCalled();
  });

  it.each([
    EVENT_TYPES.holdHeld,
    EVENT_TYPES.holdReleased,
    EVENT_TYPES.holdExpired,
    EVENT_TYPES.holdExtended,
  ])('advances each affected trip generation for %s', async (type) => {
    const increment = vi
      .fn()
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(8);
    const cache = { increment } as unknown as CacheAsideService;
    const handler = new CacheInvalidationConsumer(
      mockRouteVersion,
      mockStations,
      mockTripStops,
      cache,
    );
    const envelope: EventEnvelope = {
      id: randomUUID(),
      type,
      version: 1,
      occurredAt: new Date().toISOString(),
      correlationId: randomUUID(),
      producer: 'inventory',
      payload: {
        holdId: randomUUID(),
        bookingKey: randomUUID(),
        ownerId: randomUUID(),
        aggregateVersion: 2,
        state: type === EVENT_TYPES.holdExpired ? 'EXPIRED' : 'HELD',
        allocationOutcome: AllocationOutcome.SAME_COACH,
        expiresAt: new Date().toISOString(),
        extensionUsed: type === EVENT_TYPES.holdExtended,
        reason: type.split('.').at(-1),
        legs: [
          {
            tripId: 'trip-a',
            travelClassId: 'first',
            originStationId: 'a',
            destinationStationId: 'b',
            originPosition: 0,
            destinationPosition: 2,
            outcome: AllocationOutcome.SAME_COACH,
          },
          {
            tripId: 'trip-a',
            travelClassId: 'first',
            originStationId: 'b',
            destinationStationId: 'c',
            originPosition: 2,
            destinationPosition: 3,
            outcome: AllocationOutcome.SAME_COACH,
          },
          {
            tripId: 'trip-b',
            travelClassId: 'first',
            originStationId: 'c',
            destinationStationId: 'd',
            originPosition: 0,
            destinationPosition: 1,
            outcome: AllocationOutcome.SAME_COACH,
          },
        ],
      },
    };

    await expect(handler.handle(envelope)).resolves.toEqual({
      status: 'handled',
    });
    expect(increment.mock.calls).toEqual([
      ['catalog:availability-version:v1:trip-a'],
      ['catalog:availability-version:v1:trip-a'],
      ['catalog:availability-version:v1:trip-b'],
    ]);
  });

  it('fails the event when its durable cache side effect cannot be applied', async () => {
    const cache = {
      increment: vi.fn().mockResolvedValue(null),
    } as unknown as CacheAsideService;
    const handler = new CacheInvalidationConsumer(
      mockRouteVersion,
      mockStations,
      mockTripStops,
      cache,
    );
    await expect(
      handler.handle({
        id: randomUUID(),
        type: EVENT_TYPES.holdHeld,
        version: 1,
        occurredAt: new Date().toISOString(),
        correlationId: randomUUID(),
        producer: 'inventory',
        payload: { legs: [{ tripId: 'trip-a' }] },
      }),
    ).rejects.toThrow('Seat availability invalidation failed');
  });
});
