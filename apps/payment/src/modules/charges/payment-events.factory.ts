import {
  PAYMENT_SUCCEEDED_EVENT_TYPE,
  PAYMENT_SUCCEEDED_VERSION,
  type PaymentSucceededEvent,
} from '@app/contracts';

interface BuildPaymentSucceededProps {
  eventId: string;
  correlationId: string;
  occurredAt: Date;
  payload: {
    bookingReference: string;
    paymentReference: string;
    amountPiastres: number;
    currency: string;
    stripeEventId: string;
  };
}

export function buildPaymentSucceeded(
  props: BuildPaymentSucceededProps,
): PaymentSucceededEvent {
  return {
    id: props.eventId,
    type: PAYMENT_SUCCEEDED_EVENT_TYPE,
    version: PAYMENT_SUCCEEDED_VERSION,
    occurredAt: props.occurredAt.toISOString(),
    correlationId: props.correlationId,
    producer: 'payment',
    payload: props.payload,
  };
}
