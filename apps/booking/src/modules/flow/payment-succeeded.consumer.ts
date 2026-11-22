import { Injectable } from '@nestjs/common';
import {
  PAYMENT_SUCCEEDED_EVENT_TYPE,
  PAYMENT_SUCCEEDED_VERSION,
  type EventEnvelope,
} from '@app/contracts';
import type {
  EventHandlerPort,
  EventHandlingResult,
  EventSubscription,
} from '@app/messaging';
import { BookingFlowRepository } from './booking-flow.repository.js';
import { parsePaymentSucceededEvent } from './payment-succeeded.parser.js';
import { PermanentEventError } from '@app/messaging/event-errors.js';

export const BOOKING_PAYMENT_QUEUES = {
  [PAYMENT_SUCCEEDED_EVENT_TYPE]: 'booking.payment.succeeded',
} as const;

export function createPaymentSucceededSubscriptions(
  handler: EventHandlerPort,
): EventSubscription[] {
  return Object.entries(BOOKING_PAYMENT_QUEUES).map(
    ([eventType, queueName]) => ({
      eventType,
      queueName,
      version: PAYMENT_SUCCEEDED_VERSION,
      handler,
    }),
  );
}

/**
 * The event arrives while the booking may still be `payment_starting`, with
 * `payment_reference` not yet recorded. `beginConfirming` matches on the
 * booking reference the event carries, not on the charge reference, so it
 * still wins that race.
 */
@Injectable()
export class PaymentSucceededConsumer implements EventHandlerPort {
  constructor(private readonly repository: BookingFlowRepository) {}

  async handle(envelope: EventEnvelope): Promise<EventHandlingResult> {
    const payload = parsePaymentSucceededEvent(envelope);

    const started = await this.repository.beginConfirming({
      bookingReference: payload.bookingReference,
      paymentEventId: payload.stripeEventId,
      paymentReference: payload.paymentReference,
      amountPiastres: payload.amountPiastres,
      currency: payload.currency,
    });
    if (started) return { status: 'handled' };

    // Not started: either a foreign/deleted booking, or one already past
    // this step (a duplicate delivery). Only the former is skipped.
    const draft = await this.repository.findById(payload.bookingReference);
    if (!draft) return { status: 'skipped', skipReason: 'unknown_booking' };
    if (
      !draft.paymentSucceededAt &&
      (draft.totalPiastres !== payload.amountPiastres ||
        payload.currency !== 'EGP' ||
        (draft.paymentReference &&
          draft.paymentReference !== payload.paymentReference))
    ) {
      throw new PermanentEventError(
        'Payment does not match the locked booking.',
        'invalid-payload',
      );
    }
    return { status: 'handled' };
  }
}
