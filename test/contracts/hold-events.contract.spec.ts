import { describe, expect, it } from 'vitest';
import {
  AllocationOutcome,
  HOLD_LIFECYCLE_PAYLOAD_KEYS,
  type HoldLifecyclePayloadV1,
} from '@app/contracts';
import { buildHoldEvent } from '../../apps/inventory/src/modules/seat-hold/hold-events.factory.js';
import { parseHoldLifecycleEvent } from '../../apps/booking/src/modules/draft/hold-lifecycle.parser.js';

const ids = {
  event: '10000000-0000-4000-8000-000000000001',
  hold: '10000000-0000-4000-8000-000000000002',
  key: '10000000-0000-4000-8000-000000000003',
  owner: '10000000-0000-4000-8000-000000000004',
  trip: '10000000-0000-4000-8000-000000000005',
  travelClass: '10000000-0000-4000-8000-000000000006',
  origin: '10000000-0000-4000-8000-000000000007',
  destination: '10000000-0000-4000-8000-000000000008',
};
const occurredAt = new Date('2026-11-15T12:00:00.000Z');
const base: HoldLifecyclePayloadV1 = {
  holdId: ids.hold,
  bookingKey: ids.key,
  ownerId: ids.owner,
  aggregateVersion: 1,
  state: 'HELD',
  reason: 'held',
  extensionUsed: false,
  expiresAt: '2026-11-15T12:15:00.000Z',
  allocationOutcome: AllocationOutcome.SIDE_BY_SIDE,
  legs: [
    {
      tripId: ids.trip,
      travelClassId: ids.travelClass,
      originStationId: ids.origin,
      destinationStationId: ids.destination,
      originPosition: 0,
      destinationPosition: 2,
      outcome: AllocationOutcome.SIDE_BY_SIDE,
    },
  ],
};
const cases: { action: string; payload: HoldLifecyclePayloadV1 }[] = [
  { action: 'held', payload: base },
  {
    action: 'released',
    payload: {
      ...base,
      aggregateVersion: 2,
      state: 'RELEASED',
      reason: 'released',
    },
  },
  {
    action: 'expired',
    payload: {
      ...base,
      aggregateVersion: 2,
      state: 'EXPIRED',
      reason: 'expired',
    },
  },
  {
    action: 'extended',
    payload: {
      ...base,
      aggregateVersion: 2,
      reason: 'extended',
      extensionUsed: true,
      expiresAt: '2026-11-15T12:20:00.000Z',
    },
  },
];

describe.each(cases)(
  'Inventory $action v1 producer / Booking consumer contract',
  ({ action, payload }) => {
    const event = () =>
      buildHoldEvent({
        eventId: ids.event,
        correlationId: ids.key,
        occurredAt,
        payload,
      });

    it('matches the golden routing envelope and accepted required payload', () => {
      const envelope = JSON.parse(JSON.stringify(event()));
      expect(envelope).toEqual({
        id: ids.event,
        type: `inventory.hold.${action}`,
        version: 1,
        occurredAt: occurredAt.toISOString(),
        correlationId: ids.key,
        producer: 'inventory',
        payload,
      });
      expect(Object.keys(envelope.payload).sort()).toEqual(
        [...HOLD_LIFECYCLE_PAYLOAD_KEYS].sort(),
      );
      expect(parseHoldLifecycleEvent(envelope)).toEqual(payload);
    });

    it('accepts additive fields without persisting them in the consumer projection', () => {
      const envelope = event();
      envelope.payload = {
        ...payload,
        futureFlag: true,
        legs: payload.legs.map((leg) => ({ ...leg, futureCount: 3 })),
      } as HoldLifecyclePayloadV1;
      expect(parseHoldLifecycleEvent(envelope)).toEqual(payload);
    });

    it('rejects unsupported versions and every missing required payload field', () => {
      expect(() => parseHoldLifecycleEvent({ ...event(), version: 2 })).toThrow(
        'Invalid Inventory hold lifecycle payload',
      );
      for (const key of HOLD_LIFECYCLE_PAYLOAD_KEYS) {
        const incomplete = { ...payload } as Record<string, unknown>;
        delete incomplete[key];
        expect(
          () => parseHoldLifecycleEvent({ ...event(), payload: incomplete }),
          key,
        ).toThrow();
      }
    });

    it('rejects sensitive data even when disguised as an additive field', () => {
      for (const field of [
        'nationalId',
        'national_id',
        'passengerToken',
        'maskedNationalId',
        'passengerName',
      ]) {
        expect(() =>
          parseHoldLifecycleEvent({
            ...event(),
            payload: { ...payload, future: { [field]: 'private' } },
          }),
        ).toThrow();
      }
    });
  },
);

it('replacement is one released event, not a new event type', () => {
  const payload: HoldLifecyclePayloadV1 = {
    ...base,
    aggregateVersion: 2,
    state: 'RELEASED',
    reason: 'replaced',
  };
  const envelope = buildHoldEvent({
    eventId: ids.event,
    correlationId: ids.key,
    occurredAt,
    payload,
  });
  expect(envelope.type).toBe('inventory.hold.released');
  expect(parseHoldLifecycleEvent(envelope)).toEqual(payload);
});

it('the Inventory payload factory excludes passenger identities and display snapshots', () => {
  const payload = {
    ...base,
    legs: base.legs.map((leg) => ({ ...leg, passengerToken: 'private-token' })),
    assignments: [
      {
        passengerToken: 'private-token',
        nationalId: 'private-id',
        displayName: 'private-name',
        maskedNationalId: 'private-mask',
      },
    ],
  } as HoldLifecyclePayloadV1;
  const envelope = buildHoldEvent({
    eventId: ids.event,
    correlationId: ids.key,
    occurredAt,
    payload,
  });
  expect(envelope.payload).toEqual(base);
  expect(JSON.stringify(envelope)).not.toContain('private');
});
