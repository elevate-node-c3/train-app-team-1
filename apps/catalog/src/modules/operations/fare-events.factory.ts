import {
  FARE_CHANGED_EVENT_TYPE,
  FARE_CHANGED_VERSION,
  type FareChangedEvent,
  type FareChangedPayloadV1,
} from '@app/contracts';

interface BuildFareChangedProps {
  eventId: string;
  correlationId: string;
  occurredAt: Date;
  payload: FareChangedPayloadV1;
}

/** Mirrors `buildTripPublished` in `trip-events.factory.ts`. */
export function buildFareChanged(
  props: BuildFareChangedProps,
): FareChangedEvent {
  return {
    id: props.eventId,
    type: FARE_CHANGED_EVENT_TYPE,
    version: FARE_CHANGED_VERSION,
    occurredAt: props.occurredAt.toISOString(),
    correlationId: props.correlationId,
    producer: 'catalog',
    payload: props.payload,
  };
}
