import { Inject, Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type Stripe from 'stripe';
import { randomUUID } from 'node:crypto';
import { OUTBOX, type OutboxPort } from '@app/messaging';
import {
  UNIT_OF_WORK,
  type UnitOfWorkPort,
} from '@app/common/persistence/unit-of-work.port.js';
import { entityManagerOf } from '@app/common/persistence/typeorm-unit-of-work.js';
import { buildPaymentSucceeded } from '../payment-events.factory.js';

/** Only charge events move a booking; setup intents stay the saved-cards' concern. */
const CHARGE_EVENT_PREFIX = 'payment_intent.';

export type ChargeWebhookResult = 'recorded' | 'duplicate';

interface StripeEventRow {
  id: string;
  type: string;
  object_id: string;
  payload: unknown;
}

interface SettledCharge {
  id: string;
  booking_reference: string;
  idempotency_key: string;
  amount_piastres: number;
  currency: string;
  status: 'started' | 'succeeded' | 'cancelled';
  stripe_payment_method_id: string | null;
  stripe_customer_id?: string | null;
  stripe_payment_intent_id?: string | null;
}

/**
 * Records a signature-verified Stripe event before anything is done with it:
 * the inbox row is what earns the 2xx, the outcome is what the saga reads later.
 */
@Injectable()
export class ChargeWebhookService {
  private readonly logger = new Logger(ChargeWebhookService.name);

  constructor(
    private readonly dataSource: DataSource,
    @Inject(OUTBOX) private readonly outbox: OutboxPort,
    @Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWorkPort,
  ) {}

  async record(event: Stripe.Event): Promise<ChargeWebhookResult> {
    if (!event.type.startsWith(CHARGE_EVENT_PREFIX)) {
      return 'duplicate';
    }

    const inserted = (await this.dataSource.query(
      `INSERT INTO stripe_event (id, type, object_id, payload, received_at, processed_at, attempts, last_error)
       VALUES ($1, $2, $3, $4::jsonb, now(), NULL, 0, NULL)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [event.id, event.type, (event.data.object as { id: string }).id, JSON.stringify(event.data.object)],
    )) as { id: string }[];

    return inserted.length > 0 ? 'recorded' : 'duplicate';
  }

  /** Settles every unhandled charge event, one transaction per confirmation. */
  async processPending(limit = 50): Promise<number> {
    const events = (await this.dataSource.query(
      `SELECT id, type, object_id, payload
         FROM stripe_event
        WHERE processed_at IS NULL
        ORDER BY received_at, id
        LIMIT $1`,
      [limit],
    )) as StripeEventRow[];

    let settled = 0;
    for (const event of events) {
      const charge = (await this.dataSource.query(
        `SELECT * FROM payment_charge WHERE stripe_payment_intent_id = $1`,
        [event.object_id],
      )) as SettledCharge[];

      if (event.type === 'payment_intent.succeeded') {
        const intent = (event.payload ?? {}) as {
          amount?: number;
          currency?: string;
        };
        const amountPiastres = Number(intent.amount ?? 0);
        const currency = String(intent.currency ?? '');

        if (
          !charge[0] ||
          amountPiastres !== charge[0].amount_piastres ||
          currency.toLowerCase() !== charge[0].currency.toLowerCase()
        ) {
          // Stripe reported an amount that is not the locked total: an alarm,
          // never a confirmation. Nothing is published and the charge is left alone.
          await this.dataSource.query(
            `UPDATE stripe_event SET processed_at = now(), last_error = $2 WHERE id = $1`,
            [
              event.id,
              `amount ${amountPiastres} does not match the locked ${charge[0]?.amount_piastres ?? 0} piastres`,
            ],
          );
          this.logger.error(
            `Stripe amount ${amountPiastres} does not match the locked total for ${event.object_id}`,
          );
          settled += 1;
          continue;
        }

        await this.unitOfWork.withTransaction(async (ctx) => {
          const manager = entityManagerOf(ctx);
          await manager.query(
            `UPDATE payment_charge
                SET status = 'succeeded'
              WHERE id = $1 AND status <> 'succeeded'`,
            [charge[0].id],
          );
          await this.outbox.append(
            ctx,
            buildPaymentSucceeded({
              eventId: randomUUID(),
              correlationId: event.id,
              occurredAt: new Date(),
              payload: {
                bookingReference: charge[0].booking_reference,
                paymentReference: charge[0].id,
                amountPiastres: charge[0].amount_piastres,
                currency: charge[0].currency,
                stripeEventId: event.id,
              },
            }),
          );
          await manager.query(
            `UPDATE stripe_event SET processed_at = now() WHERE id = $1`,
            [event.id],
          );
        });

        settled += 1;
        continue;
      }

      if (event.type === 'payment_intent.failed') {
        // Forward only: a late failure for an earlier attempt never overwrites a
        // recorded success, and a succeeded charge is never moved backwards.
        await this.dataSource.query(
          `UPDATE stripe_event SET processed_at = now() WHERE id = $1`,
          [event.id],
        );
        settled += 1;
      }
    }

    return settled;
  }
}
