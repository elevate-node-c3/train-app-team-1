import {
  TRIP_PUBLISHED_EVENT_TYPE,
  TRIP_PUBLISHED_VERSION,
  TRIP_WITHDRAWN_EVENT_TYPE,
  TRIP_WITHDRAWN_VERSION,
  type TripWithdrawnEvent,
  type TripPublishedEvent,
  type TripPublishedPayloadV1,
} from '@app/contracts';

interface BuildTripPublishedProps {
  eventId: string;
  correlationId: string;
  occurredAt: Date;
  payload: TripPublishedPayloadV1;
}

export function buildTripPublished(
  props: BuildTripPublishedProps,
): TripPublishedEvent {
  return {
    id: props.eventId,
    type: TRIP_PUBLISHED_EVENT_TYPE,
    version: TRIP_PUBLISHED_VERSION,
    occurredAt: props.occurredAt.toISOString(),
    correlationId: props.correlationId,
    producer: 'catalog',
    payload: props.payload,
  };
}

interface BuildTripWithdrawnProps {
  eventId: string;
  correlationId: string;
  occurredAt: Date;
  tripId: string;
}

export function buildTripWithdrawn(
  props: BuildTripWithdrawnProps,
): TripWithdrawnEvent {
  return {
    id: props.eventId,
    type: TRIP_WITHDRAWN_EVENT_TYPE,
    version: TRIP_WITHDRAWN_VERSION,
    occurredAt: props.occurredAt.toISOString(),
    correlationId: props.correlationId,
    producer: 'catalog',
    payload: {
      tripId: props.tripId,
    },
  };
}
