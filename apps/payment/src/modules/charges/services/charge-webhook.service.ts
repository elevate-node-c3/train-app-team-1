import { Inject, Injectable, Logger } from '@nestjs/common';
import type Stripe from 'stripe';
import { randomUUID } from 'node:crypto';
import { OUTBOX, type OutboxPort } from '@app/messaging';
import {
  UNIT_OF_WORK,
  type UnitOfWorkPort,
} from '@app/common/persistence/unit-of-work.port.js';
import { buildPaymentSucceeded } from '../payment-events.factory.js';
import { PaymentChargeRepository } from '../repositories/payment-charge.repository.js';
import { StripeEventRepository } from '../repositories/stripe-event.repository.js';
import type {
  ChargeIntentPayload,
  ChargeWebhookResult,
} from '../types/stripe-event.types.js';

/** Only charge events move a booking; setup intents stay the saved-cards' concern. */
const CHARGE_EVENT_PREFIX = 'payment_intent.';

/**
 * Records a signature-verified Stripe event before anything is done with it:
 * the inbox row is what earns the 2xx, the outcome is what the saga reads later.
 */
@Injectable()
export class ChargeWebhookService {
  private readonly logger = new Logger(ChargeWebhookService.name);

  constructor(
    private readonly charges: PaymentChargeRepository,
    private readonly events: StripeEventRepository,
    @Inject(OUTBOX) private readonly outbox: OutboxPort,
    @Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWorkPort,
  ) {}

  async record(event: Stripe.Event): Promise<ChargeWebhookResult> {
    if (!event.type.startsWith(CHARGE_EVENT_PREFIX)) {
      return 'duplicate';
    }

    const inserted = await this.events.record({
      id: event.id,
      type: event.type,
      objectId: (event.data.object as { id: string }).id,
      payload: event.data.object,
    });

    return inserted ? 'recorded' : 'duplicate';
  }

  /** Settles every unhandled charge event, one transaction per confirmation. */
  async processPending(limit = 50): Promise<number> {
    const events = await this.events.findPending(limit);

    let settled = 0;
    for (const event of events) {
      const charge = await this.charges.findByPaymentIntentId(event.objectId);

      if (event.type === 'payment_intent.succeeded') {
        const intent = (event.payload ?? {}) as ChargeIntentPayload;
        const amountPiastres = Number(intent.amount ?? 0);
        const currency = String(intent.currency ?? '');

        if (
          !charge ||
          amountPiastres !== charge.amountPiastres ||
          currency.toLowerCase() !== charge.currency.toLowerCase()
        ) {
          // Stripe reported an amount that is not the locked total: an alarm,
          // never a confirmation. Nothing is published and the charge is left alone.
          await this.events.markRejected(
            event.id,
            `amount ${amountPiastres} does not match the locked ${charge?.amountPiastres ?? 0} piastres`,
          );
          this.logger.error(
            `Stripe amount ${amountPiastres} does not match the locked total for ${event.objectId}`,
          );
          settled += 1;
          continue;
        }

        await this.unitOfWork.withTransaction(async (ctx) => {
          await this.charges.markSucceeded(charge.id, ctx);
          await this.outbox.append(
            ctx,
            buildPaymentSucceeded({
              eventId: randomUUID(),
              correlationId: event.id,
              occurredAt: new Date(),
              payload: {
                bookingReference: charge.bookingReference,
                paymentReference: charge.id,
                amountPiastres: charge.amountPiastres,
                currency: charge.currency,
                stripeEventId: event.id,
              },
            }),
          );
          await this.events.markProcessed(event.id, ctx);
        });

        settled += 1;
        continue;
      }

      if (event.type === 'payment_intent.failed') {
        // Forward only: a late failure for an earlier attempt never overwrites a
        // recorded success, and a succeeded charge is never moved backwards.
        await this.events.markProcessed(event.id);
        settled += 1;
      }
    }

    return settled;
  }
}
