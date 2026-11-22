import { Inject, Injectable, Logger } from '@nestjs/common';
import type Stripe from 'stripe';
import { randomUUID } from 'node:crypto';
import { OUTBOX, type OutboxPort } from '@app/messaging';
import {
  UNIT_OF_WORK,
  type UnitOfWorkPort,
  type TransactionContext,
} from '@app/common/persistence/unit-of-work.port.js';
import { buildPaymentSucceeded } from '../payment-events.factory.js';
import { PaymentChargeRepository } from '../repositories/payment-charge.repository.js';
import { StripeEventRepository } from '../repositories/stripe-event.repository.js';
import type {
  ChargeIntentPayload,
  ChargeWebhookResult,
} from '../types/stripe-event.types.js';
import type { StripeEventRecord } from '../types/stripe-event.types.js';
import type { PaymentIntentSnapshot } from '../types/payment-intent.types.js';

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

  async recoveryInfo(): Promise<{
    pendingStripeEvents: number;
    rejectedStripeEvents: number;
    intentRecoveryProblems: number;
  }> {
    const [events, intentRecoveryProblems] = await Promise.all([
      this.events.recoveryCounts(),
      this.charges.countRecoveryProblems(),
    ]);
    return { ...events, intentRecoveryProblems };
  }

  async record(event: Stripe.Event): Promise<ChargeWebhookResult> {
    if (!event.type.startsWith(CHARGE_EVENT_PREFIX)) {
      return 'ignored';
    }

    const payload = { ...event.data.object } as Record<string, unknown>;
    delete payload.client_secret;
    const inserted = await this.events.record({
      id: event.id,
      type: event.type,
      objectId: (event.data.object as { id: string }).id,
      payload,
    });

    return inserted ? 'recorded' : 'duplicate';
  }

  /** A successful authenticated Stripe retrieve is also recoverable evidence. */
  async recordVerifiedIntent(intent: PaymentIntentSnapshot): Promise<void> {
    if (intent.status !== 'succeeded') return;
    await this.events.record({
      id: `reconciled:${intent.id}:succeeded`,
      type: 'payment_intent.succeeded',
      objectId: intent.id,
      payload: {
        id: intent.id,
        status: intent.status,
        amount: intent.amount,
        amount_received: intent.amountReceived,
        currency: intent.currency,
        metadata: intent.metadata,
      },
    });
  }

  /** Settles every unhandled charge event, one transaction per confirmation. */
  async processPending(limit = 50): Promise<number> {
    let settled = 0;
    for (let index = 0; index < limit; index += 1) {
      let claimed: StripeEventRecord | undefined;
      try {
        const result = await this.unitOfWork.withTransaction(async (ctx) => {
          claimed = await this.events.claimPending(ctx);
          if (!claimed) return undefined;
          return this.process(claimed, ctx);
        });
        if (result === undefined) break;
        if (result) settled += 1;
      } catch (error: unknown) {
        if (!claimed) throw error;
        const message =
          error instanceof Error
            ? error.message
            : 'Stripe event processing failed';
        await this.events.retry(claimed.id, message);
        this.logger.error(
          `Stripe inbox event ${claimed.id} will retry: ${message}`,
        );
      }
    }
    return settled;
  }

  private async process(
    event: StripeEventRecord,
    ctx: TransactionContext,
  ): Promise<boolean> {
    // payment_failed is an attempt outcome, not a backwards charge transition.
    // created/processing/canceled and other irrelevant events must also drain.
    if (event.type !== 'payment_intent.succeeded') {
      await this.events.markProcessed(event.id, ctx);
      return true;
    }

    const intent = (event.payload ?? {}) as ChargeIntentPayload;
    let charge = await this.charges.findByPaymentIntentId(event.objectId, ctx);
    if (!charge) {
      const { bookingReference, paymentReference } = intent.metadata ?? {};
      const uuid =
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (
        bookingReference &&
        paymentReference &&
        uuid.test(bookingReference) &&
        uuid.test(paymentReference)
      ) {
        const correlated = await this.charges.findByReference(
          paymentReference,
          bookingReference,
          ctx,
        );
        if (
          correlated?.intentCreationStartedAt &&
          intent.amount === correlated.amountPiastres &&
          intent.currency?.toLowerCase() ===
            correlated.currency.toLowerCase() &&
          (await this.charges.bindPaymentIntent(
            correlated,
            event.objectId,
            ctx,
          ))
        ) {
          charge = correlated;
        }
      }
    }
    if (!charge) {
      await this.events.retry(
        event.id,
        `No durable charge mapping for ${event.objectId}; reconciliation required`,
        ctx,
      );
      this.logger.error(
        `Unmapped verified Stripe success ${event.objectId} remains recoverable`,
      );
      return false;
    }

    if (
      intent.status !== 'succeeded' ||
      intent.amount !== charge.amountPiastres ||
      intent.amount_received !== charge.amountPiastres ||
      intent.currency?.toLowerCase() !== charge.currency.toLowerCase()
    ) {
      const message = `Stripe ${event.objectId}: requested ${intent.amount}, received ${intent.amount_received} ${intent.currency}; locked ${charge.amountPiastres} ${charge.currency}`;
      await this.events.markRejected(event.id, message, ctx);
      this.logger.error(`ALERT: ${message}`);
      return true;
    }

    if (await this.charges.markSucceeded(charge.id, ctx)) {
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
    }
    await this.events.markProcessed(event.id, ctx);
    return true;
  }
}
