import {
  HOLD_EVENT_VERSION,
  HOLD_EXPIRED_EVENT_TYPE,
  HOLD_EXTENDED_EVENT_TYPE,
  HOLD_HELD_EVENT_TYPE,
  HOLD_RELEASED_EVENT_TYPE,
  type EventEnvelope,
  type HoldEventReason,
  type HoldLifecyclePayloadV1,
} from '@app/contracts';

export type HoldEventType =
  | typeof HOLD_HELD_EVENT_TYPE
  | typeof HOLD_RELEASED_EVENT_TYPE
  | typeof HOLD_EXPIRED_EVENT_TYPE
  | typeof HOLD_EXTENDED_EVENT_TYPE;

const EVENT_TYPE_BY_REASON: Record<HoldEventReason, HoldEventType> = {
  held: HOLD_HELD_EVENT_TYPE,
  released: HOLD_RELEASED_EVENT_TYPE,
  expired: HOLD_EXPIRED_EVENT_TYPE,
  replaced: HOLD_RELEASED_EVENT_TYPE,
  extended: HOLD_EXTENDED_EVENT_TYPE,
};

export function buildHoldEvent(props: {
  eventId: string;
  correlationId: string;
  occurredAt: Date;
  payload: HoldLifecyclePayloadV1;
}): EventEnvelope<HoldEventType, HoldLifecyclePayloadV1> {
  return {
    id: props.eventId,
    type: EVENT_TYPE_BY_REASON[props.payload.reason],
    version: HOLD_EVENT_VERSION,
    occurredAt: props.occurredAt.toISOString(),
    correlationId: props.correlationId,
    producer: 'inventory',
    // Event serialization is an allowlist, never a passenger/receipt spread.
    payload: {
      holdId: props.payload.holdId,
      bookingKey: props.payload.bookingKey,
      ownerId: props.payload.ownerId,
      aggregateVersion: props.payload.aggregateVersion,
      state: props.payload.state,
      allocationOutcome: props.payload.allocationOutcome,
      legs: props.payload.legs.map((leg) => ({
        tripId: leg.tripId,
        travelClassId: leg.travelClassId,
        originStationId: leg.originStationId,
        destinationStationId: leg.destinationStationId,
        originPosition: leg.originPosition,
        destinationPosition: leg.destinationPosition,
        outcome: leg.outcome,
      })),
      expiresAt: props.payload.expiresAt,
      extensionUsed: props.payload.extensionUsed,
      reason: props.payload.reason,
    },
  };
}
