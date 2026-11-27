import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { DataSource } from 'typeorm';
import type Stripe from 'stripe';
import { DataSourceInitializer } from '@app/common/persistence/data-source-initializer.js';
import { TypeOrmUnitOfWork } from '@app/common/persistence/typeorm-unit-of-work.js';
import { TypeOrmOutboxRepository } from '@app/messaging';
import { ChargeCardRepository } from '../../apps/payment/src/modules/charges/repositories/charge-card.repository.js';
import { PaymentChargeRepository } from '../../apps/payment/src/modules/charges/repositories/payment-charge.repository.js';
import { StripeEventRepository } from '../../apps/payment/src/modules/charges/repositories/stripe-event.repository.js';
import { ChargeWebhookService } from '../../apps/payment/src/modules/charges/services/charge-webhook.service.js';
import { PaymentDoubleService } from '../../apps/payment/src/modules/charges/services/payment-double.service.js';
import { PaymentChargeEntity } from '../../apps/payment/src/modules/charges/entities/payment-charge.entity.js';
import { StripeEventEntity } from '../../apps/payment/src/modules/charges/entities/stripe-event.entity.js';
import { SavedCardEntity } from '../../apps/payment/src/modules/cards/entities/saved-card.entity.js';
import {
  closePaymentDataSource,
  paymentDataSource,
  truncatePayment,
} from './support/payment-database.js';

let source: DataSource;
let charges: PaymentChargeRepository;
let cards: ChargeCardRepository;
let events: StripeEventRepository;
let unitOfWork: TypeOrmUnitOfWork;
let outbox: TypeOrmOutboxRepository;

async function givenCharge() {
  const id = randomUUID();
  const bookingReference = randomUUID();
  const idempotencyKey = `booking:${bookingReference}:charge`;
  await charges.createStarted({
    id,
    bookingReference,
    idempotencyKey,
    amountPiastres: 6955,
    currency: 'EGP',
    cardBrand: null,
    cardLast4: null,
    stripePaymentMethodId: null,
  });
  return { id, bookingReference, idempotencyKey };
}

function succeededEvent(amount = 6955): Stripe.Event {
  return {
    id: 'evt_1',
    type: 'payment_intent.succeeded',
    data: {
      object: {
        id: 'pi_1',
        status: 'succeeded',
        amount,
        amount_received: amount,
        currency: 'egp',
      },
    },
  } as unknown as Stripe.Event;
}

describe('payment schema', () => {
  beforeAll(async () => {
    source = await paymentDataSource();
  });

  beforeEach(async () => {
    await truncatePayment(source);
    charges = new PaymentChargeRepository(
      source.getRepository(PaymentChargeEntity),
    );
    cards = new ChargeCardRepository(source.getRepository(SavedCardEntity));
    events = new StripeEventRepository(source.getRepository(StripeEventEntity));
    const initializer = new DataSourceInitializer(source);
    unitOfWork = new TypeOrmUnitOfWork(initializer);
    outbox = new TypeOrmOutboxRepository(initializer);
  });

  afterAll(async () => {
    await closePaymentDataSource();
  });

  it('has an outbox_event table with the unpublished partial index', async () => {
    const columns: { column_name: string }[] = await source.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'outbox_event'`,
    );
    expect(columns.map((c) => c.column_name)).toEqual(
      expect.arrayContaining([
        'id',
        'event_type',
        'event_version',
        'routing_key',
        'payload',
        'correlation_id',
        'producer',
        'occurred_at',
        'published_at',
        'attempt_count',
        'next_attempt_at',
        'last_error',
      ]),
    );
    const indexes: { indexname: string }[] = await source.query(
      `SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'outbox_event'`,
    );
    expect(indexes.map((i) => i.indexname)).toContain(
      'idx_outbox_event_unpublished',
    );
  });

  it('retains different event IDs for the same object and type', async () => {
    await source.query(
      `INSERT INTO stripe_event (id, type, object_id, payload)
       VALUES ('evt_1', 'payment_intent.succeeded', 'pi_1', '{}'::jsonb)`,
    );
    await expect(
      source.query(
        `INSERT INTO stripe_event (id, type, object_id, payload)
         VALUES ('evt_2', 'payment_intent.succeeded', 'pi_1', '{}'::jsonb)`,
      ),
    ).resolves.toBeDefined();
    expect(await source.query('SELECT id FROM stripe_event')).toHaveLength(2);
  });

  it('persists and finds charges by booking, key, reference and payment intent', async () => {
    const charge = await givenCharge();
    await charges.savePaymentIntent(charge.bookingReference, 'pi_1');

    const expected = {
      id: charge.id,
      bookingReference: charge.bookingReference,
      amountPiastres: 6955,
      stripePaymentIntentId: 'pi_1',
    };
    expect(
      await charges.findByBookingOrKey(charge.bookingReference, 'other-key'),
    ).toMatchObject(expected);
    expect(
      await charges.findByBookingOrKey(randomUUID(), charge.idempotencyKey),
    ).toMatchObject(expected);
    expect(
      await charges.findByReference(charge.id, charge.bookingReference),
    ).toMatchObject(expected);
    expect(await charges.findByPaymentIntentId('pi_1')).toMatchObject(expected);
    expect(
      await charges.findByReference(charge.id, randomUUID()),
    ).toBeUndefined();
    expect(await charges.findByPaymentIntentId('pi_missing')).toBeUndefined();
  });

  it('keeps the original charge when a start is repeated', async () => {
    const charge = await givenCharge();
    await charges.createStarted({
      ...charge,
      id: randomUUID(),
      amountPiastres: 6955,
      currency: 'EGP',
      cardBrand: null,
      cardLast4: null,
      stripePaymentMethodId: null,
    });
    expect(
      await charges.findByBookingOrKey(
        charge.bookingReference,
        charge.idempotencyKey,
      ),
    ).toMatchObject({ id: charge.id });
  });

  it('cancels only a matching started charge and detects empty update results', async () => {
    const charge = await givenCharge();
    expect(await charges.cancelStarted(charge.id, randomUUID())).toBe(false);
    expect(
      await charges.cancelStarted(randomUUID(), charge.bookingReference),
    ).toBe(false);
    expect(
      await charges.cancelStarted(charge.id, charge.bookingReference),
    ).toBe(true);
    expect(
      await charges.cancelStarted(charge.id, charge.bookingReference),
    ).toBe(false);
    expect(await charges.findStatus(charge.id, charge.bookingReference)).toBe(
      'cancelled',
    );

    await charges.markStartedSucceeded(charge.id);
    expect(await charges.findStatus(charge.id, charge.bookingReference)).toBe(
      'cancelled',
    );
  });

  it('refunds a succeeded charge without letting cancellation overwrite it', async () => {
    const charge = await givenCharge();
    await charges.refundSucceeded(charge.id, 6955);
    expect(await charges.findStatus(charge.id, charge.bookingReference)).toBe(
      'started',
    );

    await charges.markStartedSucceeded(charge.id);
    expect(
      await charges.cancelStarted(charge.id, charge.bookingReference),
    ).toBe(false);
    expect(await charges.findStatus(charge.id, charge.bookingReference)).toBe(
      'succeeded',
    );
    await charges.refundSucceeded(charge.id, 6955);
    expect(await charges.findStatus(charge.id, charge.bookingReference)).toBe(
      'refunded',
    );
  });

  it('refunds the whole amount exactly once under concurrent dummy refund requests', async () => {
    const charge = await givenCharge();
    await charges.markStartedSucceeded(charge.id);
    const service = new PaymentDoubleService(charges, cards, {} as never);
    const request = {
      bookingReference: charge.bookingReference,
      paymentReference: charge.id,
      idempotencyKey: `booking:${charge.bookingReference}:refund`,
      amountPiastres: 6955,
    };
    const responses = await Promise.all([
      service.refund(request),
      service.refund(request),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([
      'ALREADY_REFUNDED',
      'REFUNDED',
    ]);
    expect(responses.map((response) => response.amountPiastres)).toEqual([
      6955, 6955,
    ]);
    expect(responses[0].refundReference).toBe(responses[1].refundReference);
    expect(await charges.findStatus(charge.id, charge.bookingReference)).toBe(
      'refunded',
    );
  });

  it('scopes card reads and usage updates to the owner and resolves Stripe customers', async () => {
    const accountId = randomUUID();
    const cardId = randomUUID();
    await source.query(
      `INSERT INTO payment_customer (id, account_id, stripe_customer_id)
       VALUES ($1, $2, 'cus_real')`,
      [randomUUID(), accountId],
    );
    await source.query(
      `INSERT INTO saved_card
         (id, account_id, stripe_customer_id, stripe_payment_method_id,
          brand, last4, exp_month, exp_year, cardholder_name, fingerprint)
       VALUES ($1, $2, 'cus_real', 'pm_real', 'visa', '4242', 12, 2030, 'Traveller', 'fp_1')`,
      [cardId, accountId],
    );
    expect(await cards.findOwned(cardId, accountId)).toMatchObject({
      stripePaymentMethodId: 'pm_real',
      status: 'active',
    });
    expect(await cards.findOwned(cardId, randomUUID())).toBeUndefined();
    expect(await cards.findCustomerIdByPaymentMethodId('pm_real')).toBe(
      'cus_real',
    );
    expect(
      await cards.findCustomerIdByPaymentMethodId('pm_missing'),
    ).toBeUndefined();

    await cards.markUsed(cardId, randomUUID());
    const [untouched]: { last_used_at: Date | null }[] = await source.query(
      'SELECT last_used_at FROM saved_card WHERE id = $1',
      [cardId],
    );
    expect(untouched.last_used_at).toBeNull();
    await cards.markUsed(cardId, accountId);
    const [used]: { last_used_at: Date | null }[] = await source.query(
      'SELECT last_used_at FROM saved_card WHERE id = $1',
      [cardId],
    );
    expect(used.last_used_at).toBeInstanceOf(Date);
  });

  it('deduplicates recorded events and processes a bounded pending batch', async () => {
    const event = {
      id: 'evt_1',
      type: 'payment_intent.succeeded',
      objectId: 'pi_1',
      payload: { amount: 6955, currency: 'egp' },
    };
    expect(await events.record(event)).toBe(true);
    expect(await events.record(event)).toBe(false);
    expect(await events.record({ ...event, id: 'evt_2' })).toBe(true);
    expect(
      await events.record({ ...event, id: 'evt_3', objectId: 'pi_2' }),
    ).toBe(true);
    expect(await events.findPending(0)).toEqual([]);
    expect(await events.findPending(1)).toEqual([event]);

    await events.markProcessed('evt_1');
    await events.markProcessed('evt_2');
    await events.markRejected('evt_3', 'wrong amount');
    expect(await events.findPending(50)).toEqual([]);
    const [rejected]: { last_error: string }[] = await source.query(
      "SELECT last_error FROM stripe_event WHERE id = 'evt_3'",
    );
    expect(rejected.last_error).toBe('wrong amount');
  });

  it('commits charge success, the outbox event and inbox completion together', async () => {
    const charge = await givenCharge();
    await charges.savePaymentIntent(charge.bookingReference, 'pi_1');
    const service = new ChargeWebhookService(
      charges,
      events,
      outbox,
      unitOfWork,
    );
    expect(await service.record(succeededEvent())).toBe('recorded');
    expect(await service.processPending()).toBe(1);
    expect(await charges.findStatus(charge.id, charge.bookingReference)).toBe(
      'succeeded',
    );
    expect(await events.findPending(50)).toEqual([]);

    const rows: { event_type: string; payload: Record<string, unknown> }[] =
      await source.query('SELECT event_type, payload FROM outbox_event');
    expect(rows).toEqual([
      {
        event_type: 'payment.charge.succeeded',
        payload: {
          bookingReference: charge.bookingReference,
          paymentReference: charge.id,
          amountPiastres: 6955,
          currency: 'EGP',
          stripeEventId: 'evt_1',
        },
      },
    ]);
    expect(await service.processPending()).toBe(0);
  });

  it('rolls back charge and outbox writes when processing fails before inbox completion', async () => {
    const charge = await givenCharge();
    await charges.savePaymentIntent(charge.bookingReference, 'pi_1');
    const service = new ChargeWebhookService(
      charges,
      events,
      {
        append: async (ctx, event) => {
          await outbox.append(ctx, event);
          throw new Error('processing failed');
        },
        appendBatch: (ctx, envelopes) => outbox.appendBatch(ctx, envelopes),
      },
      unitOfWork,
    );
    await service.record(succeededEvent());
    expect(await service.processPending()).toBe(0);
    expect(await charges.findStatus(charge.id, charge.bookingReference)).toBe(
      'started',
    );
    expect(await events.findPending(50)).toHaveLength(1);
    expect(await source.query('SELECT id FROM outbox_event')).toEqual([]);
  });

  it('claims concurrent inbox processors exclusively and never duplicates the outbox event', async () => {
    const charge = await givenCharge();
    await charges.savePaymentIntent(charge.bookingReference, 'pi_1');
    const first = new ChargeWebhookService(charges, events, outbox, unitOfWork);
    const second = new ChargeWebhookService(
      charges,
      events,
      outbox,
      unitOfWork,
    );
    await first.record(succeededEvent());
    await Promise.all([first.processPending(), second.processPending()]);
    expect(await source.query('SELECT id FROM outbox_event')).toHaveLength(1);
    expect(await events.findPending(50)).toEqual([]);
  });

  it('does not regress refunded state when another success event is received', async () => {
    const charge = await givenCharge();
    await charges.savePaymentIntent(charge.bookingReference, 'pi_1');
    const service = new ChargeWebhookService(
      charges,
      events,
      outbox,
      unitOfWork,
    );
    await service.record(succeededEvent());
    await service.processPending();
    await charges.refundSucceeded(charge.id, 6955);
    await service.record({ ...succeededEvent(), id: 'evt_later_success' });
    await service.processPending();
    expect(await charges.findStatus(charge.id, charge.bookingReference)).toBe(
      'refunded',
    );
    expect(await source.query('SELECT id FROM outbox_event')).toHaveLength(1);
  });

  it('keeps an unknown mapping pending and recovers once its durable ID appears', async () => {
    const charge = await givenCharge();
    const service = new ChargeWebhookService(
      charges,
      events,
      outbox,
      unitOfWork,
    );
    await service.record(succeededEvent());
    expect(await service.processPending()).toBe(0);
    expect(await events.findPending(50)).toHaveLength(1);
    await charges.savePaymentIntent(charge.bookingReference, 'pi_1');
    await source.query(
      `UPDATE stripe_event SET next_attempt_at = now() WHERE id = 'evt_1'`,
    );
    expect(await service.processPending()).toBe(1);
    expect(await source.query('SELECT id FROM outbox_event')).toHaveLength(1);
    expect(await events.recoveryCounts()).toMatchObject({
      rejectedStripeEvents: 0,
    });
  });

  it('binds verified creation metadata when a crash lost the intent mapping', async () => {
    const charge = await givenCharge();
    await source.query(
      'UPDATE payment_charge SET intent_creation_started_at = now() WHERE id = $1',
      [charge.id],
    );
    const event = succeededEvent();
    Object.assign(event.data.object, {
      metadata: {
        bookingReference: charge.bookingReference,
        paymentReference: charge.id,
      },
    });
    const service = new ChargeWebhookService(
      charges,
      events,
      outbox,
      unitOfWork,
    );
    await service.record(event);
    expect(await service.processPending()).toBe(1);
    expect(
      (await charges.findByReference(charge.id, charge.bookingReference))
        ?.stripePaymentIntentId,
    ).toBe('pi_1');
    expect(await charges.findStatus(charge.id, charge.bookingReference)).toBe(
      'succeeded',
    );
  });

  it('rejects a short capture with durable evidence and no full-payment outcome', async () => {
    const charge = await givenCharge();
    await charges.savePaymentIntent(charge.bookingReference, 'pi_1');
    const event = succeededEvent();
    Object.assign(event.data.object, { amount_received: 3000 });
    const service = new ChargeWebhookService(
      charges,
      events,
      outbox,
      unitOfWork,
    );
    await service.record(event);
    await service.processPending();
    expect(await charges.findStatus(charge.id, charge.bookingReference)).toBe(
      'started',
    );
    expect(await source.query('SELECT id FROM outbox_event')).toHaveLength(0);
    expect(await events.recoveryCounts()).toMatchObject({
      rejectedStripeEvents: 1,
    });
  });

  it('drains ordinary created/payment_failed events before processing a later success', async () => {
    const charge = await givenCharge();
    await charges.savePaymentIntent(charge.bookingReference, 'pi_1');
    const service = new ChargeWebhookService(
      charges,
      events,
      outbox,
      unitOfWork,
    );
    for (let index = 0; index < 50; index += 1) {
      await events.record({
        id: `evt_created_${index}`,
        type:
          index % 2
            ? 'payment_intent.created'
            : 'payment_intent.payment_failed',
        objectId: `pi_${index}`,
        payload: {},
      });
    }
    await service.record(succeededEvent());
    expect(await service.processPending()).toBe(50);
    expect(await service.processPending()).toBe(1);
    expect(await source.query('SELECT id FROM outbox_event')).toHaveLength(1);
  });
});
