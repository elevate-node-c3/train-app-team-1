import type { EventEnvelope } from './event-envelope.js';
import { EVENT_TYPES } from './event-types.js';

/**
 * What a booking is worth when it reaches payment. The amount travels with the
 * event so a consumer never has to ask booking what a reference was for.
 */
export interface BookingAwaitingPaymentPayloadV1 {
  bookingReference: string;
  totalPiastres: number;
}

export const BOOKING_AWAITING_PAYMENT_EVENT_TYPE =
  EVENT_TYPES.bookingAwaitingPayment;

export const BOOKING_AWAITING_PAYMENT_VERSION = 1;

export const BOOKING_AWAITING_PAYMENT_PAYLOAD_KEYS = [
  'bookingReference',
  'totalPiastres',
] as const;

export type BookingAwaitingPaymentEvent = EventEnvelope<
  typeof BOOKING_AWAITING_PAYMENT_EVENT_TYPE,
  BookingAwaitingPaymentPayloadV1
>;

/** The hold ran out before the traveller paid; the seats are already released. */
export interface BookingExpiredPayloadV1 {
  bookingReference: string;
  totalPiastres: number;
}

export const BOOKING_EXPIRED_EVENT_TYPE = EVENT_TYPES.bookingExpired;

export const BOOKING_EXPIRED_VERSION = 1;

export type BookingExpiredEvent = EventEnvelope<
  typeof BOOKING_EXPIRED_EVENT_TYPE,
  BookingExpiredPayloadV1
>;

/** The traveller walked away. Reconciliation and the drop-off KPI read this. */
export interface BookingAbandonedPayloadV1 {
  bookingReference: string;
  totalPiastres: number;
}

export const BOOKING_ABANDONED_EVENT_TYPE = EVENT_TYPES.bookingAbandoned;

export const BOOKING_ABANDONED_VERSION = 1;

export type BookingAbandonedEvent = EventEnvelope<
  typeof BOOKING_ABANDONED_EVENT_TYPE,
  BookingAbandonedPayloadV1
>;
