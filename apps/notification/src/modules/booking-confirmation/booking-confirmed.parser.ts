import {
  BOOKING_CONFIRMED_EVENT_TYPE,
  BOOKING_CONFIRMED_VERSION,
  type BookingConfirmedPayloadV1,
  type BookingConfirmedTicketV1,
  type EventEnvelope,
  type LocalizedName,
  type TripEndpoint,
} from '@app/contracts';
import { PermanentEventError } from '@app/messaging/event-errors.js';

function invalid(message: string): never {
  throw new PermanentEventError(message, 'invalid-payload');
}

/**
 * The email is built from this payload alone -- notification never reads
 * booking's database -- so every field it prints is checked here once.
 */
export function parseBookingConfirmedEvent(
  envelope: EventEnvelope,
): BookingConfirmedPayloadV1 {
  if (
    envelope.type !== BOOKING_CONFIRMED_EVENT_TYPE ||
    envelope.version !== BOOKING_CONFIRMED_VERSION ||
    envelope.producer !== 'booking'
  )
    invalid('Invalid booking.confirmed envelope.');

  const record = objectOf(envelope.payload, 'payload');
  if (
    typeof record.bookingReference !== 'string' ||
    typeof record.accountId !== 'string' ||
    record.accountId.length === 0 ||
    typeof record.bookingCode !== 'string' ||
    !Number.isSafeInteger(record.totalPiastres) ||
    !Array.isArray(record.tickets) ||
    record.tickets.length === 0
  )
    invalid('Invalid booking.confirmed payload.');

  return {
    bookingReference: record.bookingReference,
    accountId: record.accountId,
    bookingCode: record.bookingCode,
    totalPiastres: record.totalPiastres as number,
    tickets: record.tickets.map(ticketOf),
  };
}

function ticketOf(value: unknown): BookingConfirmedTicketV1 {
  const ticket = objectOf(value, 'ticket');
  if (
    typeof ticket.ticketNumber !== 'string' ||
    typeof ticket.ticketId !== 'string' ||
    typeof ticket.passengerRef !== 'string' ||
    typeof ticket.tripId !== 'string' ||
    typeof ticket.passengerName !== 'string' ||
    !Number.isSafeInteger(ticket.trainNumber) ||
    !Number.isSafeInteger(ticket.coachNumber) ||
    typeof ticket.seatNumber !== 'string' ||
    !Number.isSafeInteger(ticket.durationMinutes) ||
    !Number.isSafeInteger(ticket.farePiastres) ||
    typeof ticket.qr !== 'string' ||
    ticket.qr.length === 0
  )
    invalid('Invalid booking.confirmed ticket.');

  return {
    ticketNumber: ticket.ticketNumber,
    ticketId: ticket.ticketId,
    passengerRef: ticket.passengerRef,
    tripId: ticket.tripId,
    passengerName: ticket.passengerName,
    trainNumber: ticket.trainNumber as number,
    travelClass: localizedNameOf(ticket.travelClass),
    boarding: endpointOf(ticket.boarding),
    alighting: endpointOf(ticket.alighting),
    coachNumber: ticket.coachNumber as number,
    seatNumber: ticket.seatNumber,
    durationMinutes: ticket.durationMinutes as number,
    farePiastres: ticket.farePiastres as number,
    qr: ticket.qr,
  };
}

function endpointOf(value: unknown): TripEndpoint {
  const endpoint = objectOf(value, 'endpoint');
  const at = objectOf(endpoint.at, 'endpoint time');
  if (
    typeof endpoint.stationId !== 'string' ||
    typeof at.localDate !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(at.localDate) ||
    typeof at.localTime !== 'string' ||
    !/^\d{2}:\d{2}$/.test(at.localTime)
  )
    invalid('Invalid booking.confirmed station.');

  return {
    stationId: endpoint.stationId,
    name: localizedNameOf(endpoint.name),
    at: {
      localDate: at.localDate,
      localTime: at.localTime,
      utcOffset: typeof at.utcOffset === 'string' ? at.utcOffset : '',
      iso: typeof at.iso === 'string' ? at.iso : '',
      timeZone: typeof at.timeZone === 'string' ? at.timeZone : '',
    },
  };
}

function localizedNameOf(value: unknown): LocalizedName {
  const name = objectOf(value, 'name');
  if (typeof name.en !== 'string' || typeof name.ar !== 'string')
    invalid('Invalid booking.confirmed name.');
  return { en: name.en, ar: name.ar };
}

function objectOf(value: unknown, what: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    invalid(`Invalid booking.confirmed ${what}.`);
  return value as Record<string, unknown>;
}
