import { isISO8601 } from 'class-validator';
import {
  TICKET_CANCELLED_EVENT_TYPE,
  TICKET_CANCELLED_PAYLOAD_KEYS,
  TICKET_CANCELLED_VERSION,
  type EventEnvelope,
  type TicketCancelledPayloadV1,
} from '@app/contracts';
import { PermanentEventError } from '@app/messaging/event-errors.js';

function invalid(): never {
  throw new PermanentEventError(
    'Invalid ticket.cancelled payload.',
    'invalid-payload',
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** Required v1 fields are strict; harmless additive fields are ignored. */
export function parseTicketCancelledEvent(
  envelope: EventEnvelope,
): TicketCancelledPayloadV1 {
  if (
    envelope.type !== TICKET_CANCELLED_EVENT_TYPE ||
    envelope.version !== TICKET_CANCELLED_VERSION ||
    envelope.producer !== 'booking' ||
    !isISO8601(envelope.occurredAt, { strict: true, strictSeparator: true })
  )
    invalid();

  const value = envelope.payload;
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const payload = value as Record<string, unknown>;

  for (const key of TICKET_CANCELLED_PAYLOAD_KEYS) {
    if (!(key in payload)) invalid();
  }

  // Booking decides the amount; payment only validates and records it.
  if (
    !isNonEmptyString(payload.ticketId) ||
    !isNonEmptyString(payload.bookingReference) ||
    !isNonEmptyString(payload.passengerRef) ||
    !isNonEmptyString(payload.tripId) ||
    !isNonEmptyString(payload.accountId) ||
    !isNonEmptyString(payload.paymentReference) ||
    !isNonEmptyString(payload.seatNumber) ||
    !Number.isSafeInteger(payload.refundPiastres) ||
    (payload.refundPiastres as number) <= 0 ||
    !Number.isSafeInteger(payload.coachNumber) ||
    (payload.coachNumber as number) <= 0
  )
    invalid();

  return {
    ticketId: payload.ticketId as string,
    bookingReference: payload.bookingReference as string,
    passengerRef: payload.passengerRef as string,
    tripId: payload.tripId as string,
    coachNumber: payload.coachNumber as number,
    seatNumber: payload.seatNumber as string,
    accountId: payload.accountId as string,
    refundPiastres: payload.refundPiastres as number,
    paymentReference: payload.paymentReference as string,
  };
}
