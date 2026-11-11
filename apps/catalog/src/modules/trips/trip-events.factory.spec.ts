import {
  TRIP_PUBLISHED_EVENT_TYPE,
  TRIP_PUBLISHED_PAYLOAD_KEYS,
  TRIP_PUBLISHED_VERSION,
  TRIP_WITHDRAWN_EVENT_TYPE,
  TRIP_WITHDRAWN_PAYLOAD_KEYS,
  TRIP_WITHDRAWN_VERSION,
  type TripPublishedPayloadV1,
} from '@app/contracts';
import { describe, expect, it } from 'vitest';

import { buildTripPublished, buildTripWithdrawn } from './trip-events.factory.js';

const TRIP = '11111111-1111-4111-8111-111111111111';
const TRAIN = '22222222-2222-4222-8222-222222222222';
const STATION = '33333333-3333-4333-8333-333333333333';

const occurredAt = new Date('2026-06-20T09:00:00.000Z');

function payload(): TripPublishedPayloadV1 {
  return {
    tripId: TRIP,
    trainId: TRAIN,
    trainNumber: 916,
    trainType: { id: 'tt', nameEn: 'VIP', nameAr: 'في اي بي' },
    serviceDate: '2026-06-20',
    timetableVersion: 3,
    capacity: 170,
    stops: [
      {
        stationId: STATION,
        position: 1,
        arrivalAt: null,
        departureAt: '2026-06-20T20:00:00.000Z',
      },
    ],
    coaches: [
      {
        position: 1,
        coachNumber: 5,
        travelClass: {
          id: 'first',
          nameEn: 'First Class AC',
          nameAr: 'الدرجة الأولى المكيفة',
        },
        coachLayout: {
          id: 'layout',
          layoutName: '2+1 First Class AC',
          rows: [{ rowNumber: 1, leftSeats: ['1', '2'], rightSeats: ['3'] }],
        },
      },
    ],
  };
}

describe('Trip events', () => {
  describe('buildTripPublished', () => {
    it('stamps the type, version and producer inventory subscribes to', () => {
      const event = buildTripPublished({
        eventId: 'event-1',
        correlationId: 'corr-1',
        occurredAt,
        payload: payload(),
      });

      expect(event.id).toBe('event-1');
      expect(event.type).toBe(TRIP_PUBLISHED_EVENT_TYPE);
      expect(event.type).toBe('catalog.trip.published');
      expect(event.version).toBe(TRIP_PUBLISHED_VERSION);
      expect(event.producer).toBe('catalog');
      expect(event.correlationId).toBe('corr-1');
      expect(event.occurredAt).toBe('2026-06-20T09:00:00.000Z');
    });

    it('carries exactly the payload keys the contract declares', () => {
      const event = buildTripPublished({
        eventId: 'event-1',
        correlationId: 'corr-1',
        occurredAt,
        payload: payload(),
      });

      expect(Object.keys(event.payload).sort()).toEqual(
        [...TRIP_PUBLISHED_PAYLOAD_KEYS].sort(),
      );
    });

    it('keeps everything inventory needs to create seats without calling back', () => {
      const event = buildTripPublished({
        eventId: 'event-1',
        correlationId: 'corr-1',
        occurredAt,
        payload: payload(),
      });

      // Identity and date, so inventory knows which run it is seating.
      expect(event.payload.tripId).toBe(TRIP);
      expect(event.payload.trainId).toBe(TRAIN);
      expect(event.payload.serviceDate).toBe('2026-06-20');
      expect(event.payload.trainType.nameAr).toBe('في اي بي');

      // Positions, so a segment "stop i to stop j" means the same on both sides.
      expect(event.payload.stops[0].position).toBe(1);

      // Seat numbers and the adjacency they imply: same side of a row is side
      // by side, which is what SEAT-2 groups on.
      const [row] = event.payload.coaches[0].coachLayout.rows;
      expect(row.leftSeats).toEqual(['1', '2']);
      expect(row.rightSeats).toEqual(['3']);
    });
  });

  describe('buildTripWithdrawn', () => {
    it('stamps the type, version and producer, and carries the trip', () => {
      const event = buildTripWithdrawn({
        eventId: 'event-2',
        correlationId: 'corr-2',
        occurredAt,
        tripId: TRIP,
      });

      expect(event.type).toBe(TRIP_WITHDRAWN_EVENT_TYPE);
      expect(event.type).toBe('catalog.trip.withdrawn');
      expect(event.version).toBe(TRIP_WITHDRAWN_VERSION);
      expect(event.producer).toBe('catalog');
      expect(event.payload.tripId).toBe(TRIP);
    });

    it('carries exactly the payload keys the contract declares', () => {
      const event = buildTripWithdrawn({
        eventId: 'event-2',
        correlationId: 'corr-2',
        occurredAt,
        tripId: TRIP,
      });

      expect(Object.keys(event.payload).sort()).toEqual(
        [...TRIP_WITHDRAWN_PAYLOAD_KEYS].sort(),
      );
    });
  });
});
