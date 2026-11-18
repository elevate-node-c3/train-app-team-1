import {
  SEAT_AVAILABILITY_CHANGED_EVENT_TYPE,
  SEAT_AVAILABILITY_CHANGED_VERSION,
  TRIP_PUBLICATION_REFUSED_EVENT_TYPE,
  TRIP_PUBLICATION_REFUSED_VERSION,
  TRIP_SEATS_CREATED_EVENT_TYPE,
  TRIP_SEATS_CREATED_VERSION,
  type SeatAvailabilityChangedEvent,
  type SeatAvailabilityChangedPayloadV1,
  type TripPublicationRefusedEvent,
  type TripPublicationRefusedPayloadV1,
  type TripSeatsCreatedEvent,
  type TripSeatsCreatedPayloadV1,
} from '@app/contracts';

interface BuildTripSeatsCreatedProps {
  eventId: string;
  correlationId: string;
  occurredAt: Date;
  payload: TripSeatsCreatedPayloadV1;
}

export function buildTripSeatsCreated(
  props: BuildTripSeatsCreatedProps,
): TripSeatsCreatedEvent {
  return {
    id: props.eventId,
    type: TRIP_SEATS_CREATED_EVENT_TYPE,
    version: TRIP_SEATS_CREATED_VERSION,
    occurredAt: props.occurredAt.toISOString(),
    correlationId: props.correlationId,
    producer: 'inventory',
    payload: props.payload,
  };
}

interface BuildTripPublicationRefusedProps {
  eventId: string;
  correlationId: string;
  occurredAt: Date;
  payload: TripPublicationRefusedPayloadV1;
}

export function buildTripPublicationRefused(
  props: BuildTripPublicationRefusedProps,
): TripPublicationRefusedEvent {
  return {
    id: props.eventId,
    type: TRIP_PUBLICATION_REFUSED_EVENT_TYPE,
    version: TRIP_PUBLICATION_REFUSED_VERSION,
    occurredAt: props.occurredAt.toISOString(),
    correlationId: props.correlationId,
    producer: 'inventory',
    payload: props.payload,
  };
}

interface BuildSeatAvailabilityChangedProps {
  eventId: string;
  correlationId: string;
  occurredAt: Date;
  payload: SeatAvailabilityChangedPayloadV1;
}

export function buildSeatAvailabilityChanged(
  props: BuildSeatAvailabilityChangedProps,
): SeatAvailabilityChangedEvent {
  return {
    id: props.eventId,
    type: SEAT_AVAILABILITY_CHANGED_EVENT_TYPE,
    version: SEAT_AVAILABILITY_CHANGED_VERSION,
    occurredAt: props.occurredAt.toISOString(),
    correlationId: props.correlationId,
    producer: 'inventory',
    payload: props.payload,
  };
}
