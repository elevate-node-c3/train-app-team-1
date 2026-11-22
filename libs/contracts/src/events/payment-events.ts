import type { EventEnvelope } from './event-envelope.js';
import { EVENT_TYPES } from './event-types.js';

/**
 * What payment answered for a booking. The amount is the locked total, so a
 * confirmation can be checked against it instead of trusting the client.
 */
export interface PaymentSucceededPayloadV1 {
  bookingReference: string;
  paymentReference: string;
  amountPiastres: number;
  currency: string;
  stripeEventId: string;
}

export const PAYMENT_SUCCEEDED_EVENT_TYPE = EVENT_TYPES.paymentSucceeded;

export const PAYMENT_SUCCEEDED_VERSION = 1;

export const PAYMENT_SUCCEEDED_PAYLOAD_KEYS = [
  'bookingReference',
  'paymentReference',
  'amountPiastres',
  'currency',
  'stripeEventId',
] as const satisfies readonly (keyof PaymentSucceededPayloadV1)[];

export type PaymentSucceededEvent = EventEnvelope<
  typeof PAYMENT_SUCCEEDED_EVENT_TYPE,
  PaymentSucceededPayloadV1
>;

/** Payment could not take the money; booking keeps waiting or compensates. */
export interface PaymentFailedPayloadV1 {
  bookingReference: string;
  paymentReference: string;
  amountPiastres: number;
  currency: string;
  stripeEventId: string;
}

export const PAYMENT_FAILED_EVENT_TYPE = EVENT_TYPES.paymentFailed;

export const PAYMENT_FAILED_VERSION = 1;

export type PaymentFailedEvent = EventEnvelope<
  typeof PAYMENT_FAILED_EVENT_TYPE,
  PaymentFailedPayloadV1
>;
