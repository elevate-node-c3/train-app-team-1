import { beforeEach, describe, expect, it, vi } from 'vitest';
import type Stripe from 'stripe';
import { ChargeWebhookService } from './charge-webhook.service.js';
import type {
  TransactionContext,
  UnitOfWorkPort,
} from '@app/common/persistence/unit-of-work.port.js';
import type { OutboxPort } from '@app/messaging';
import type { PaymentChargeRepository } from '../repositories/payment-charge.repository.js';
import type { StripeEventRepository } from '../repositories/stripe-event.repository.js';
import type { Charge } from '../types/charge.types.js';
import type { StripeEventRecord } from '../types/stripe-event.types.js';

const BOOKING = '22222222-2222-4222-8222-222222222222';
const CHARGE = '00000000-0000-4000-8000-000000000001';
const success = (
  id = 'evt_1',
  overrides: Record<string, unknown> = {},
): Stripe.Event =>
  ({
    id,
    type: 'payment_intent.succeeded',
    data: {
      object: {
        id: 'pi_1',
        status: 'succeeded',
        amount: 6955,
        amount_received: 6955,
        currency: 'egp',
        metadata: { bookingReference: BOOKING, paymentReference: CHARGE },
        ...overrides,
      },
    },
  }) as unknown as Stripe.Event;

describe('ChargeWebhookService durable inbox', () => {
  let rows: (StripeEventRecord & {
    processed: boolean;
    deferred: boolean;
    error: string | null;
    owner?: TransactionContext;
  })[];
  let charge: Charge | undefined;
  let published: unknown[];
  let events: ReturnType<typeof eventRepository>;
  let charges: ReturnType<typeof chargeRepository>;
  let outbox: {
    append: ReturnType<typeof vi.fn>;
    appendBatch: ReturnType<typeof vi.fn>;
  };
  let service: ChargeWebhookService;

  function eventRepository() {
    return {
      record: vi.fn(async (event: StripeEventRecord) => {
        if (rows.some((row) => row.id === event.id)) return false;
        rows.push({ ...event, processed: false, deferred: false, error: null });
        return true;
      }),
      claimPending: vi.fn(async (ctx: TransactionContext) => {
        const row = rows.find(
          (candidate) =>
            !candidate.processed && !candidate.deferred && !candidate.owner,
        );
        if (row) row.owner = ctx;
        return row;
      }),
      markProcessed: vi.fn(async (id: string) => {
        rows.find((row) => row.id === id)!.processed = true;
      }),
      markRejected: vi.fn(async (id: string, error: string) => {
        Object.assign(
          rows.find((row) => row.id === id)!,
          { processed: true, error },
        );
      }),
      retry: vi.fn(async (id: string, error: string) => {
        Object.assign(
          rows.find((row) => row.id === id)!,
          { deferred: true, error },
        );
      }),
    };
  }

  function chargeRepository() {
    return {
      findByPaymentIntentId: vi.fn(async (id: string) =>
        charge?.stripePaymentIntentId === id ? { ...charge } : undefined,
      ),
      findByReference: vi.fn(async (id: string, bookingReference: string) =>
        charge?.id === id && charge.bookingReference === bookingReference
          ? { ...charge }
          : undefined,
      ),
      bindPaymentIntent: vi.fn(async (_charge: Charge, id: string) => {
        if (
          !charge ||
          (charge.stripePaymentIntentId && charge.stripePaymentIntentId !== id)
        )
          return false;
        charge.stripePaymentIntentId = id;
        return true;
      }),
      markSucceeded: vi.fn(async () => {
        if (!charge || !['started', 'cancelled'].includes(charge.status))
          return false;
        charge.status = 'succeeded';
        return true;
      }),
    };
  }

  beforeEach(() => {
    rows = [];
    published = [];
    charge = {
      id: CHARGE,
      bookingReference: BOOKING,
      idempotencyKey: 'charge_key',
      amountPiastres: 6955,
      currency: 'EGP',
      status: 'started',
      stripePaymentIntentId: 'pi_1',
    };
    events = eventRepository();
    charges = chargeRepository();
    outbox = {
      append: vi.fn(async (_ctx, envelope) => {
        published.push(envelope);
      }),
      appendBatch: vi.fn(),
    };
    const uow = {
      withTransaction: async <T>(
        work: (ctx: TransactionContext) => Promise<T>,
      ) => {
        const ctx = { driver: 'test' };
        const savedCharge = charge && { ...charge };
        const count = published.length;
        try {
          return await work(ctx);
        } catch (error) {
          charge = savedCharge;
          published.splice(count);
          for (const row of rows.filter((row) => row.owner === ctx))
            row.processed = false;
          throw error;
        } finally {
          for (const row of rows.filter((row) => row.owner === ctx))
            row.owner = undefined;
        }
      },
    };
    service = new ChargeWebhookService(
      charges as unknown as PaymentChargeRepository,
      events as unknown as StripeEventRepository,
      outbox as OutboxPort,
      uow as UnitOfWorkPort,
    );
  });

  it('ignores an event belonging to another concern, and records nothing', async () => {
    const setupIntent = {
      id: 'evt_setup',
      type: 'setup_intent.succeeded',
      data: { object: { id: 'seti_1' } },
    } as unknown as Stripe.Event;

    expect(await service.record(setupIntent)).toBe('ignored');
    expect(rows).toHaveLength(0);
  });

  it('durably records without settling during the HTTP acknowledgement', async () => {
    expect(await service.record(success())).toBe('recorded');
    expect(rows[0].processed).toBe(false);
    expect(charges.findByPaymentIntentId).not.toHaveBeenCalled();
    expect(published).toHaveLength(0);
    expect(await service.record(success())).toBe('duplicate');
  });

  it('retains different events for the same object/type instead of losing attempts', async () => {
    await service.record(success());
    expect(await service.record(success('evt_2'))).toBe('recorded');
    expect(await service.processPending()).toBe(2);
    expect(published).toHaveLength(1);
  });

  it('never persists a browser client secret in the durable inbox payload', async () => {
    await service.record(
      success('evt_1', { client_secret: 'pi_1_secret_sensitive' }),
    );
    expect(events.record.mock.calls[0][0].payload).not.toHaveProperty(
      'client_secret',
    );
  });

  it('claims and settles charge, outbox and inbox in the same transaction', async () => {
    await service.record(success());
    expect(await service.processPending()).toBe(1);
    expect(charge?.status).toBe('succeeded');
    expect(rows[0].processed).toBe(true);
    const ctx = events.claimPending.mock.calls[0][0];
    expect(charges.findByPaymentIntentId).toHaveBeenCalledWith('pi_1', ctx);
    expect(charges.markSucceeded).toHaveBeenCalledWith(CHARGE, ctx);
    expect(outbox.append).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({
        type: 'payment.charge.succeeded',
        payload: expect.objectContaining({ amountPiastres: 6955 }),
      }),
    );
    expect(events.markProcessed).toHaveBeenCalledWith('evt_1', ctx);
  });

  it('drains 50 irrelevant events and then reaches success rather than starving it', async () => {
    for (let index = 0; index < 50; index += 1) {
      await service.record({
        id: `evt_created_${index}`,
        type: 'payment_intent.created',
        data: { object: { id: `pi_${index}` } },
      } as unknown as Stripe.Event);
    }
    await service.record(success());
    expect(await service.processPending()).toBe(50);
    expect(await service.processPending()).toBe(1);
    expect(published).toHaveLength(1);
  });

  it('drains the real payment_failed event without regressing a success', async () => {
    await service.record(success());
    await service.processPending();
    await service.record({
      id: 'evt_failed',
      type: 'payment_intent.payment_failed',
      data: { object: { id: 'pi_1' } },
    } as unknown as Stripe.Event);
    expect(await service.processPending()).toBe(1);
    expect(charge?.status).toBe('succeeded');
    expect(published).toHaveLength(1);
  });

  it.each([
    { amount: 7000 },
    { amount_received: 3000 },
    { currency: 'usd' },
    { status: 'processing' },
  ])(
    'rejects mismatched evidence %j durably without confirming',
    async (overrides) => {
      await service.record(success('evt_1', overrides));
      await service.processPending();
      expect(charge?.status).toBe('started');
      expect(published).toHaveLength(0);
      expect(rows[0]).toMatchObject({
        processed: true,
        error: expect.stringContaining('locked'),
      });
    },
  );

  it('keeps an unmapped verified success retryable and recovers after the mapping appears', async () => {
    charge!.stripePaymentIntentId = null;
    await service.record(success('evt_1', { metadata: {} }));
    expect(await service.processPending()).toBe(0);
    expect(rows[0]).toMatchObject({ processed: false, deferred: true });
    charge!.stripePaymentIntentId = 'pi_1';
    rows[0].deferred = false;
    expect(await service.processPending()).toBe(1);
    expect(published).toHaveLength(1);
  });

  it('recovers a crash-before-mapping using the durable creation correlation', async () => {
    charge!.stripePaymentIntentId = null;
    charge!.intentCreationStartedAt = new Date();
    await service.record(success());
    await service.processPending();
    expect(charge?.stripePaymentIntentId).toBe('pi_1');
    expect(charge?.status).toBe('succeeded');
  });

  it('does not bind arbitrary metadata to a booking that never attempted creation', async () => {
    charge!.stripePaymentIntentId = null;
    await service.record(success());
    await service.processPending();
    expect(charges.bindPaymentIntent).not.toHaveBeenCalled();
    expect(rows[0].processed).toBe(false);
  });

  it('exclusive claims prevent concurrent duplicate outbox appends', async () => {
    await service.record(success());
    await Promise.all([service.processPending(), service.processPending()]);
    expect(published).toHaveLength(1);
    expect(charges.markSucceeded).toHaveBeenCalledTimes(1);
  });

  it('does not resurrect refunded state when a distinct success delivery arrives later', async () => {
    charge!.status = 'refunded';
    await service.record(success());
    await service.processPending();
    expect(charge?.status).toBe('refunded');
    expect(rows[0].processed).toBe(true);
    expect(published).toHaveLength(0);
  });

  it('rolls back settlement on outbox failure and recovers on a later scan', async () => {
    await service.record(success());
    outbox.append.mockRejectedValueOnce(new Error('outbox unavailable'));
    expect(await service.processPending()).toBe(0);
    expect(charge?.status).toBe('started');
    expect(rows[0]).toMatchObject({ processed: false, deferred: true });
    expect(published).toHaveLength(0);
    rows[0].deferred = false;
    expect(await service.processPending()).toBe(1);
    expect(published).toHaveLength(1);
  });
});
