import type { LocalizedName, TripEndpoint } from '../catalog/catalog.dto.js';
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

/** Issued once the confirmation saga has tickets to hand over. */
export interface BookingConfirmedTicketV1 {
  ticketNumber: string;
  passengerRef: string;
  tripId: string;
  coachNumber: number;
  seatNumber: string;
  // Additive (TA-108): the ticket as issued, so the confirmation email never
  // has to ask booking for it. Never the National ID, only the signed QR.
  ticketId: string;
  passengerName: string;
  trainNumber: number;
  travelClass: LocalizedName;
  boarding: TripEndpoint;
  alighting: TripEndpoint;
  durationMinutes: number;
  farePiastres: number;
  /** The signed QR payload, exactly as the ticket prints it. */
  qr: string;
}

export interface BookingConfirmedPayloadV1 {
  bookingReference: string;
  totalPiastres: number;
  tickets: BookingConfirmedTicketV1[];
  /** Additive (TA-108): lets notification resolve the address and language. */
  accountId: string;
  /** Additive (TA-108): the short reference every ticket of this booking shares. */
  bookingCode: string;
}

export const BOOKING_CONFIRMED_EVENT_TYPE = EVENT_TYPES.bookingConfirmed;

export const BOOKING_CONFIRMED_VERSION = 1;

export type BookingConfirmedEvent = EventEnvelope<
  typeof BOOKING_CONFIRMED_EVENT_TYPE,
  BookingConfirmedPayloadV1
>;

/** A late payment forced a reallocation; the traveller's seats moved. */
export interface BookingSeatsChangedSeatV1 {
  passengerRef: string;
  tripId: string;
  coachNumber: number;
  seatNumber: string;
}

export interface BookingSeatsChangedPayloadV1 {
  bookingReference: string;
  /** Additive: lets notification resolve the traveller's address. */
  accountId: string;
  seats: BookingSeatsChangedSeatV1[];
}

export const BOOKING_SEATS_CHANGED_EVENT_TYPE =
  EVENT_TYPES.bookingSeatsChanged;

export const BOOKING_SEATS_CHANGED_VERSION = 1;

export type BookingSeatsChangedEvent = EventEnvelope<
  typeof BOOKING_SEATS_CHANGED_EVENT_TYPE,
  BookingSeatsChangedPayloadV1
>;

/** No seat was left after a late payment; the whole charge comes back. */
export type BookingRefundedReasonKey = 'REASON_NO_SEATS_AFTER_LATE_PAYMENT';

export interface BookingRefundedPayloadV1 {
  bookingReference: string;
  /** Additive: lets notification resolve the traveller's address. */
  accountId: string;
  amountPiastres: number;
  reasonKey: BookingRefundedReasonKey;
}

export const BOOKING_REFUNDED_EVENT_TYPE = EVENT_TYPES.bookingRefunded;

export const BOOKING_REFUNDED_VERSION = 1;

export type BookingRefundedEvent = EventEnvelope<
  typeof BOOKING_REFUNDED_EVENT_TYPE,
  BookingRefundedPayloadV1
>;
