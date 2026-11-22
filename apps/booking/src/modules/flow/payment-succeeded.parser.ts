import { isISO8601, isUUID } from 'class-validator';
import {
  PAYMENT_SUCCEEDED_EVENT_TYPE,
  PAYMENT_SUCCEEDED_PAYLOAD_KEYS,
  PAYMENT_SUCCEEDED_VERSION,
  type EventEnvelope,
  type PaymentSucceededPayloadV1,
} from '@app/contracts';
import { PermanentEventError } from '@app/messaging/event-errors.js';

function invalid(): never {
  throw new PermanentEventError(
    'Invalid payment.charge.succeeded payload.',
    'invalid-payload',
  );
}

function isPaymentInstant(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    isISO8601(value, { strict: true, strictSeparator: true })
  );
}

/** Required v1 fields are strict; harmless additive fields are ignored. */
export function parsePaymentSucceededEvent(
  envelope: EventEnvelope,
): PaymentSucceededPayloadV1 {
  if (
    envelope.type !== PAYMENT_SUCCEEDED_EVENT_TYPE ||
    envelope.version !== PAYMENT_SUCCEEDED_VERSION ||
    envelope.producer !== 'payment' ||
    !isPaymentInstant(envelope.occurredAt)
  )
    invalid();

  const value = envelope.payload;
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const payload = value as Record<string, unknown>;

  for (const key of PAYMENT_SUCCEEDED_PAYLOAD_KEYS) {
    if (!(key in payload)) invalid();
  }

  if (
    typeof payload.bookingReference !== 'string' ||
    !isUUID(payload.bookingReference) ||
    typeof payload.paymentReference !== 'string' ||
    !isUUID(payload.paymentReference) ||
    !Number.isSafeInteger(payload.amountPiastres) ||
    (payload.amountPiastres as number) <= 0 ||
    typeof payload.currency !== 'string' ||
    payload.currency.length === 0 ||
    typeof payload.stripeEventId !== 'string' ||
    payload.stripeEventId.length === 0
  )
    invalid();

  return {
    bookingReference: (payload.bookingReference as string).toLowerCase(),
    paymentReference: (payload.paymentReference as string).toLowerCase(),
    amountPiastres: payload.amountPiastres as number,
    currency: payload.currency as string,
    stripeEventId: payload.stripeEventId as string,
  };
}
