import {
  TRIP_PUBLICATION_REFUSED_EVENT_TYPE,
  TRIP_PUBLICATION_REFUSED_PAYLOAD_KEYS,
  TRIP_PUBLICATION_REFUSED_VERSION,
  TRIP_SEATS_CREATED_EVENT_TYPE,
  TRIP_SEATS_CREATED_PAYLOAD_KEYS,
  TRIP_SEATS_CREATED_VERSION,
} from '@app/contracts';
import { describe, expect, it } from 'vitest';

import {
  buildTripPublicationRefused,
  buildTripSeatsCreated,
} from './inventory-events.factory.js';

const TRIP = '11111111-1111-4111-8111-111111111111';
const FIRST_CLASS = '22222222-2222-4222-8222-222222222222';
const STATION = '33333333-3333-4333-8333-333333333333';

const occurredAt = new Date('2026-06-20T09:00:00.000Z');

describe('buildTripSeatsCreated', () => {
  it('names inventory as the producer and carries the per-class counts', () => {
    const event = buildTripSeatsCreated({
      eventId: 'event-1',
      correlationId: 'corr-1',
      occurredAt,
      payload: {
        tripId: TRIP,
        serviceDate: '2026-06-20',
        timetableVersion: 2,
        seatCountByClass: [{ travelClassId: FIRST_CLASS, seatCount: 10 }],
      },
    });

    expect(event).toEqual({
      id: 'event-1',
      type: 'inventory.trip.seats-created',
      version: 1,
      occurredAt: '2026-06-20T09:00:00.000Z',
      correlationId: 'corr-1',
      producer: 'inventory',
      payload: {
        tripId: TRIP,
        serviceDate: '2026-06-20',
        timetableVersion: 2,
        seatCountByClass: [{ travelClassId: FIRST_CLASS, seatCount: 10 }],
      },
    });
  });

  it('matches the contract constants', () => {
    expect(TRIP_SEATS_CREATED_EVENT_TYPE).toBe('inventory.trip.seats-created');
    expect(TRIP_SEATS_CREATED_VERSION).toBe(1);
  });

  it('carries exactly the payload keys the contract declares', () => {
    const event = buildTripSeatsCreated({
      eventId: 'event-1',
      correlationId: 'corr-1',
      occurredAt,
      payload: {
        tripId: TRIP,
        serviceDate: '2026-06-20',
        timetableVersion: 2,
        seatCountByClass: [{ travelClassId: FIRST_CLASS, seatCount: 10 }],
      },
    });

    expect(Object.keys(event.payload).sort()).toEqual(
      [...TRIP_SEATS_CREATED_PAYLOAD_KEYS].sort(),
    );
  });
});

describe('buildTripPublicationRefused', () => {
  it('carries the occupied seats and stations an operator needs', () => {
    const event = buildTripPublicationRefused({
      eventId: 'event-2',
      correlationId: 'corr-2',
      occurredAt,
      payload: {
        tripId: TRIP,
        timetableVersion: 3,
        reason: 'A seat someone is holding or has bought would be removed.',
        occupiedSeatNumbers: ['12'],
        occupiedStationIds: [STATION],
      },
    });

    expect(event).toEqual({
      id: 'event-2',
      type: 'inventory.trip.publication-refused',
      version: 1,
      occurredAt: '2026-06-20T09:00:00.000Z',
      correlationId: 'corr-2',
      producer: 'inventory',
      payload: {
        tripId: TRIP,
        timetableVersion: 3,
        reason: 'A seat someone is holding or has bought would be removed.',
        occupiedSeatNumbers: ['12'],
        occupiedStationIds: [STATION],
      },
    });
  });

  it('matches the contract constants', () => {
    expect(TRIP_PUBLICATION_REFUSED_EVENT_TYPE).toBe(
      'inventory.trip.publication-refused',
    );
    expect(TRIP_PUBLICATION_REFUSED_VERSION).toBe(1);
  });

  it('carries exactly the payload keys the contract declares', () => {
    const event = buildTripPublicationRefused({
      eventId: 'event-2',
      correlationId: 'corr-2',
      occurredAt,
      payload: {
        tripId: TRIP,
        timetableVersion: 3,
        reason: 'A seat someone is holding or has bought would be removed.',
        occupiedSeatNumbers: ['12'],
        occupiedStationIds: [STATION],
      },
    });

    expect(Object.keys(event.payload).sort()).toEqual(
      [...TRIP_PUBLICATION_REFUSED_PAYLOAD_KEYS].sort(),
    );
  });
});
