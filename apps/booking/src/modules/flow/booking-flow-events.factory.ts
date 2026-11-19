import {
  BOOKING_ABANDONED_EVENT_TYPE,
  BOOKING_ABANDONED_VERSION,
  BOOKING_AWAITING_PAYMENT_EVENT_TYPE,
  BOOKING_AWAITING_PAYMENT_VERSION,
  BOOKING_EXPIRED_EVENT_TYPE,
  BOOKING_EXPIRED_VERSION,
  type BookingAbandonedEvent,
  type BookingAwaitingPaymentEvent,
  type BookingExpiredEvent,
} from '@app/contracts';

interface BuildBookingEventProps {
  eventId: string;
  correlationId: string;
  occurredAt: Date;
  bookingReference: string;
  totalPiastres: number;
}

export function buildBookingAwaitingPayment(
  props: BuildBookingEventProps,
): BookingAwaitingPaymentEvent {
  return {
    id: props.eventId,
    type: BOOKING_AWAITING_PAYMENT_EVENT_TYPE,
    version: BOOKING_AWAITING_PAYMENT_VERSION,
    occurredAt: props.occurredAt.toISOString(),
    correlationId: props.correlationId,
    producer: 'booking',
    payload: {
      bookingReference: props.bookingReference,
      totalPiastres: props.totalPiastres,
    },
  };
}

export function buildBookingExpired(
  props: BuildBookingEventProps,
): BookingExpiredEvent {
  return {
    id: props.eventId,
    type: BOOKING_EXPIRED_EVENT_TYPE,
    version: BOOKING_EXPIRED_VERSION,
    occurredAt: props.occurredAt.toISOString(),
    correlationId: props.correlationId,
    producer: 'booking',
    payload: {
      bookingReference: props.bookingReference,
      totalPiastres: props.totalPiastres,
    },
  };
}

export function buildBookingAbandoned(
  props: BuildBookingEventProps,
): BookingAbandonedEvent {
  return {
    id: props.eventId,
    type: BOOKING_ABANDONED_EVENT_TYPE,
    version: BOOKING_ABANDONED_VERSION,
    occurredAt: props.occurredAt.toISOString(),
    correlationId: props.correlationId,
    producer: 'booking',
    payload: {
      bookingReference: props.bookingReference,
      totalPiastres: props.totalPiastres,
    },
  };
}
