import {
  FARE_CHANGED_EVENT_TYPE,
  FARE_CHANGED_VERSION,
  type FareChangedPayloadV1,
} from '@app/contracts';
import { describe, expect, it } from 'vitest';

import { buildFareChanged } from './fare-events.factory.js';

const TRAIN = '11111111-1111-4111-8111-111111111111';
const CAIRO = '22222222-2222-4222-8222-222222222222';
const ALEXANDRIA = '33333333-3333-4333-8333-333333333333';
const FIRST_CLASS_AC = '44444444-4444-4444-8444-444444444444';

const occurredAt = new Date('2026-06-20T09:00:00.000Z');

function payload(): FareChangedPayloadV1 {
  return {
    originStationId: CAIRO,
    destinationStationId: ALEXANDRIA,
    travelClassId: FIRST_CLASS_AC,
    trainId: TRAIN,
    newAmountPiastres: 20_000,
    effectiveFrom: '2026-06-20T09:00:00.000Z',
  };
}

describe('buildFareChanged', () => {
  it('stamps the type, version and producer CAT-5 subscribes to', () => {
    const event = buildFareChanged({
      eventId: 'event-1',
      correlationId: 'corr-1',
      occurredAt,
      payload: payload(),
    });

    expect(event.id).toBe('event-1');
    expect(event.type).toBe(FARE_CHANGED_EVENT_TYPE);
    expect(event.type).toBe('catalog.fare.changed');
    expect(event.version).toBe(FARE_CHANGED_VERSION);
    expect(event.producer).toBe('catalog');
    expect(event.correlationId).toBe('corr-1');
    expect(event.occurredAt).toBe('2026-06-20T09:00:00.000Z');
  });

  it('carries the train, class, pair, amount and instant CAT-5 reads', () => {
    const event = buildFareChanged({
      eventId: 'event-1',
      correlationId: 'corr-1',
      occurredAt,
      payload: payload(),
    });

    expect(event.payload).toEqual({
      originStationId: CAIRO,
      destinationStationId: ALEXANDRIA,
      travelClassId: FIRST_CLASS_AC,
      trainId: TRAIN,
      newAmountPiastres: 20_000,
      effectiveFrom: '2026-06-20T09:00:00.000Z',
    });
  });

  it('stamps occurredAt as an ISO string, not the Date it was given', () => {
    const event = buildFareChanged({
      eventId: 'event-1',
      correlationId: 'corr-1',
      occurredAt,
      payload: payload(),
    });

    expect(typeof event.occurredAt).toBe('string');
  });
});
