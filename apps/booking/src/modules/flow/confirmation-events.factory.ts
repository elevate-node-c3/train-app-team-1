import {
  BOOKING_CONFIRMED_EVENT_TYPE,
  BOOKING_CONFIRMED_VERSION,
  BOOKING_REFUNDED_EVENT_TYPE,
  BOOKING_REFUNDED_VERSION,
  BOOKING_SEATS_CHANGED_EVENT_TYPE,
  BOOKING_SEATS_CHANGED_VERSION,
  type BookingConfirmedEvent,
  type BookingConfirmedPayloadV1,
  type BookingRefundedEvent,
  type BookingRefundedPayloadV1,
  type BookingSeatsChangedEvent,
  type BookingSeatsChangedPayloadV1,
} from '@app/contracts';

interface BuildProps<TPayload> {
  eventId: string;
  correlationId: string;
  occurredAt: Date;
  payload: TPayload;
}

export function buildBookingConfirmed(
  props: BuildProps<BookingConfirmedPayloadV1>,
): BookingConfirmedEvent {
  return {
    id: props.eventId,
    type: BOOKING_CONFIRMED_EVENT_TYPE,
    version: BOOKING_CONFIRMED_VERSION,
    occurredAt: props.occurredAt.toISOString(),
    correlationId: props.correlationId,
    producer: 'booking',
    payload: props.payload,
  };
}

export function buildBookingSeatsChanged(
  props: BuildProps<BookingSeatsChangedPayloadV1>,
): BookingSeatsChangedEvent {
  return {
    id: props.eventId,
    type: BOOKING_SEATS_CHANGED_EVENT_TYPE,
    version: BOOKING_SEATS_CHANGED_VERSION,
    occurredAt: props.occurredAt.toISOString(),
    correlationId: props.correlationId,
    producer: 'booking',
    payload: props.payload,
  };
}

export function buildBookingRefunded(
  props: BuildProps<BookingRefundedPayloadV1>,
): BookingRefundedEvent {
  return {
    id: props.eventId,
    type: BOOKING_REFUNDED_EVENT_TYPE,
    version: BOOKING_REFUNDED_VERSION,
    occurredAt: props.occurredAt.toISOString(),
    correlationId: props.correlationId,
    producer: 'booking',
    payload: props.payload,
  };
}
