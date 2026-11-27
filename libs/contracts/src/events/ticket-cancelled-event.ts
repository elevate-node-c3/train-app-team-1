import type { EventEnvelope } from './event-envelope.js';

export const TICKET_CANCELLED_EVENT_TYPE = 'ticket.cancelled';

export const TICKET_CANCELLED_VERSION = 1;

export interface TicketCancelledPayloadV1 {
  ticketId: string;
  bookingReference: string;
  /** The passenger whose sold seat is released. */
  passengerRef: string;
  tripId: string;
  coachNumber: number;
  seatNumber: string;
  accountId: string;
  /** Booking's refund decision; the booking fee is never part of it. */
  refundPiastres: number;
  /** The booking's charge reference, for the refund consumer. */
  paymentReference: string;
}

export type TicketCancelledEvent = EventEnvelope<
  typeof TICKET_CANCELLED_EVENT_TYPE,
  TicketCancelledPayloadV1
>;
