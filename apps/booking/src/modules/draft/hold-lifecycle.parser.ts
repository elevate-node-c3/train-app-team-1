import { isISO8601, isUUID } from 'class-validator';
import {
  AllocationOutcome,
  HOLD_EVENT_VERSION,
  HOLD_HELD_EVENT_TYPE,
  HOLD_RELEASED_EVENT_TYPE,
  HOLD_EXPIRED_EVENT_TYPE,
  HOLD_EXTENDED_EVENT_TYPE,
  type EventEnvelope,
  type HoldEventLegV1,
  type HoldLifecyclePayloadV1,
} from '@app/contracts';
import { PermanentEventError } from '@app/messaging/event-errors.js';

function invalid(): never {
  throw new PermanentEventError(
    'Invalid Inventory hold lifecycle payload.',
    'invalid-payload',
  );
}

export function isHoldInstant(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
      value,
    ) &&
    isISO8601(value, { strict: true, strictSeparator: true })
  );
}

export function isHoldOutcome(value: unknown): value is AllocationOutcome {
  return Object.values(AllocationOutcome).includes(value as AllocationOutcome);
}

function hasPrivateFields(value: unknown, depth = 0): boolean {
  if (value === null || typeof value !== 'object') return false;
  if (depth > 12) return true;
  return Object.entries(value).some(
    ([key, child]) =>
      /national_?id|passenger_?token|masked|display_?name|passenger_?name/i.test(
        key,
      ) || hasPrivateFields(child, depth + 1),
  );
}

/** Required v1 fields are strict; harmless additive fields are ignored. */
export function parseHoldLifecycleEvent(
  envelope: EventEnvelope,
): HoldLifecyclePayloadV1 {
  if (
    envelope.version !== HOLD_EVENT_VERSION ||
    envelope.producer !== 'inventory' ||
    !isHoldInstant(envelope.occurredAt)
  )
    invalid();
  const value = envelope.payload;
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    hasPrivateFields(value)
  )
    invalid();
  const payload = value as Record<string, unknown>;
  if (
    typeof payload.holdId !== 'string' ||
    !isUUID(payload.holdId) ||
    typeof payload.bookingKey !== 'string' ||
    !isUUID(payload.bookingKey) ||
    typeof payload.ownerId !== 'string' ||
    !isUUID(payload.ownerId) ||
    !Number.isSafeInteger(payload.aggregateVersion) ||
    (payload.aggregateVersion as number) < 1 ||
    typeof payload.extensionUsed !== 'boolean' ||
    !isHoldInstant(payload.expiresAt) ||
    !isHoldOutcome(payload.allocationOutcome) ||
    !Array.isArray(payload.legs) ||
    payload.legs.length < 1 ||
    payload.legs.length > 2
  )
    invalid();

  switch (envelope.type) {
    case HOLD_HELD_EVENT_TYPE:
      if (
        payload.state !== 'HELD' ||
        payload.reason !== 'held' ||
        payload.extensionUsed
      )
        invalid();
      break;
    case HOLD_EXTENDED_EVENT_TYPE:
      if (
        payload.state !== 'HELD' ||
        payload.reason !== 'extended' ||
        !payload.extensionUsed
      )
        invalid();
      break;
    case HOLD_RELEASED_EVENT_TYPE:
      if (
        payload.state !== 'RELEASED' ||
        !['released', 'replaced'].includes(String(payload.reason))
      )
        invalid();
      break;
    case HOLD_EXPIRED_EVENT_TYPE:
      if (payload.state !== 'EXPIRED' || payload.reason !== 'expired')
        invalid();
      break;
    default:
      invalid();
  }

  const tripIds = new Set<string>();
  const legs = payload.legs.map((value: unknown): HoldEventLegV1 => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
    const leg = value as Record<string, unknown>;
    for (const key of [
      'tripId',
      'travelClassId',
      'originStationId',
      'destinationStationId',
    ]) {
      if (typeof leg[key] !== 'string' || !isUUID(leg[key])) invalid();
    }
    if (
      !Number.isSafeInteger(leg.originPosition) ||
      !Number.isSafeInteger(leg.destinationPosition) ||
      (leg.originPosition as number) < 0 ||
      (leg.destinationPosition as number) <= (leg.originPosition as number) ||
      !isHoldOutcome(leg.outcome) ||
      tripIds.has((leg.tripId as string).toLowerCase())
    )
      invalid();
    tripIds.add((leg.tripId as string).toLowerCase());
    return {
      tripId: (leg.tripId as string).toLowerCase(),
      travelClassId: (leg.travelClassId as string).toLowerCase(),
      originStationId: (leg.originStationId as string).toLowerCase(),
      destinationStationId: (leg.destinationStationId as string).toLowerCase(),
      originPosition: leg.originPosition as number,
      destinationPosition: leg.destinationPosition as number,
      outcome: leg.outcome,
    };
  });
  return {
    holdId: (payload.holdId as string).toLowerCase(),
    bookingKey: (payload.bookingKey as string).toLowerCase(),
    ownerId: (payload.ownerId as string).toLowerCase(),
    aggregateVersion: payload.aggregateVersion as number,
    state: payload.state as HoldLifecyclePayloadV1['state'],
    allocationOutcome: payload.allocationOutcome,
    legs,
    expiresAt: payload.expiresAt,
    extensionUsed: payload.extensionUsed,
    reason: payload.reason as HoldLifecyclePayloadV1['reason'],
  };
}
