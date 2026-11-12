import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { EventEnvelope } from '@app/contracts';
import { EVENT_TYPES } from '@app/contracts';

import { buildFareChanged } from '../operations/fare-events.factory.js';
import type { RouteVersionService } from '../cache/route-version.service.js';
import type { StationsService } from '../stations/stations.service.js';
import type { TripStopsService } from '../trips/trip-stops.service.js';
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
});

