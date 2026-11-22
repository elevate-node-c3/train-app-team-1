import {
  BOOKING_REFUNDED_EVENT_TYPE,
  BOOKING_REFUNDED_VERSION,
  BOOKING_SEATS_CHANGED_EVENT_TYPE,
  BOOKING_SEATS_CHANGED_VERSION,
  type BookingRefundedPayloadV1,
  type BookingSeatsChangedPayloadV1,
  type EventEnvelope,
} from '@app/contracts';
import { PermanentEventError } from '@app/messaging/event-errors.js';

function invalid(message: string): never {
  throw new PermanentEventError(message, 'invalid-payload');
}

export function parseBookingSeatsChangedEvent(
  envelope: EventEnvelope,
): BookingSeatsChangedPayloadV1 {
  if (
    envelope.type !== BOOKING_SEATS_CHANGED_EVENT_TYPE ||
    envelope.version !== BOOKING_SEATS_CHANGED_VERSION ||
    envelope.producer !== 'booking'
  )
    invalid('Invalid booking.seats-changed envelope.');

  const payload = envelope.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload))
    invalid('Invalid booking.seats-changed payload.');
  const record = payload as Record<string, unknown>;

  if (
    typeof record.bookingReference !== 'string' ||
    typeof record.accountId !== 'string' ||
    !Array.isArray(record.seats) ||
    record.seats.length === 0
  )
    invalid('Invalid booking.seats-changed payload.');

  const seats = record.seats.map((value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      invalid('Invalid booking.seats-changed seat.');
    const seat = value as Record<string, unknown>;
    if (
      typeof seat.passengerRef !== 'string' ||
      typeof seat.tripId !== 'string' ||
      !Number.isSafeInteger(seat.coachNumber) ||
      typeof seat.seatNumber !== 'string'
    )
      invalid('Invalid booking.seats-changed seat.');
    return {
      passengerRef: seat.passengerRef,
      tripId: seat.tripId,
      coachNumber: seat.coachNumber as number,
      seatNumber: seat.seatNumber,
    };
  });

  return {
    bookingReference: record.bookingReference,
    accountId: record.accountId,
    seats,
  };
}

export function parseBookingRefundedEvent(
  envelope: EventEnvelope,
): BookingRefundedPayloadV1 {
  if (
    envelope.type !== BOOKING_REFUNDED_EVENT_TYPE ||
    envelope.version !== BOOKING_REFUNDED_VERSION ||
    envelope.producer !== 'booking'
  )
    invalid('Invalid booking.refunded envelope.');

  const payload = envelope.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload))
    invalid('Invalid booking.refunded payload.');
  const record = payload as Record<string, unknown>;

  if (
    typeof record.bookingReference !== 'string' ||
    typeof record.accountId !== 'string' ||
    !Number.isSafeInteger(record.amountPiastres) ||
    (record.amountPiastres as number) <= 0 ||
    record.reasonKey !== 'REASON_NO_SEATS_AFTER_LATE_PAYMENT'
  )
    invalid('Invalid booking.refunded payload.');

  return {
    bookingReference: record.bookingReference,
    accountId: record.accountId,
    amountPiastres: record.amountPiastres as number,
    reasonKey: 'REASON_NO_SEATS_AFTER_LATE_PAYMENT',
  };
}
