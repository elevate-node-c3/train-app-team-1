import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type Stripe from 'stripe';
import { ChargeWebhookService } from './charge-webhook.service.js';
import { TypeOrmUnitOfWork } from '@app/common/persistence/typeorm-unit-of-work.js';
import type { TransactionContext } from '@app/common/persistence/unit-of-work.port.js';
import { DataSourceInitializer } from '@app/common/persistence/data-source-initializer.js';
import { OutboxPort } from '@app/messaging';

const BOOKING = '22222222-2222-4222-8222-222222222222';

interface FakeStripeEventRow {
  id: string;
  type: string;
  object_id: string;
  payload: unknown;
  received_at: string;
  processed_at: string | null;
  last_error: string | null;
}

interface FakeChargeRow {
  id: string;
  booking_reference: string;
  idempotency_key: string;
  amount_piastres: number;
  currency: string;
  status: 'started' | 'succeeded' | 'cancelled';
  stripe_payment_method_id: string | null;
  stripe_payment_intent_id?: string | null;
}

function succeededEvent(
  id: string,
  objectId: string,
  amountPiastres = 6955,
  currency = 'egp',
): Stripe.Event {
  return {
    id,
    type: 'payment_intent.succeeded',
    data: {
      object: {
        id: objectId,
        amount: amountPiastres,
        currency,
        metadata: { bookingReference: BOOKING },
      },
    },
  } as unknown as Stripe.Event;
}

function failedEvent(id: string, objectId: string): Stripe.Event {
  return {
    id,
    type: 'payment_intent.failed',
    data: { object: { id: objectId } },
  } as unknown as Stripe.Event;
}

function setupIntentEvent(id: string, objectId: string): Stripe.Event {
  return {
    id,
    type: 'setup_intent.created',
    data: { object: { id: objectId } },
  } as unknown as Stripe.Event;
}

function createFakeDataSource() {
  const events: FakeStripeEventRow[] = [];
  const charges: FakeChargeRow[] = [];

  const query = vi.fn(
    async (sql: string, params: unknown[] = []) => {
      if (sql.includes('INSERT INTO stripe_event')) {
        const id = params[0] as string;
        const type = params[1] as string;
        const objectId = params[2] as string;
        const payload = JSON.parse(String(params[3]));
        const duplicate = events.some(
          (e) => e.id === id || (e.object_id === objectId && e.type === type),
        );
        if (duplicate) {
          return [];
        }
        events.push({
          id,
          type,
          object_id: objectId,
          payload,
          received_at: new Date().toISOString(),
          processed_at: null,
          last_error: null,
        });
        return [{ id }];
      }

      if (
        sql.includes('FROM stripe_event') &&
        sql.includes('processed_at IS NULL')
      ) {
        const limit = Number(params[0]);
        const rows = events
          .filter((e) => e.processed_at === null)
          .sort((a, b) => (a.received_at < b.received_at ? -1 : 1))
          .slice(0, limit);
        return rows.map(({ id, type, object_id, payload }) => ({
          id,
          type,
          object_id,
          payload,
        }));
      }

      if (sql.includes('FROM payment_charge WHERE stripe_payment_intent_id')) {
        const intentId = params[0] as string;
        const charge = charges.find((c) => c.stripe_payment_intent_id === intentId);
        return charge ? [charge] : [];
      }

      if (sql.includes('UPDATE stripe_event')) {
        const [id, lastError] = params;
        const event = events.find((e) => e.id === id);
        if (event) {
          event.processed_at = new Date().toISOString();
          event.last_error = lastError;
        }
        return [];
      }

      if (sql.includes("SET status = 'succeeded'")) {
        const id = params[0] as string;
        const charge = charges.find((c) => c.id === id);
        if (charge) charge.status = 'succeeded';
        return [];
      }

      return [];
    },
  );

  return { query, events, charges };
}

describe('ChargeWebhookService', () => {
  let ds: ReturnType<typeof createFakeDataSource>;
  let outbox: OutboxPort;
  let service: ChargeWebhookService;
  let published: unknown[];
  let logs: string[];
  let unitOfWork: TypeOrmUnitOfWork;

  const processedAt = (id: string) =>
    ds.events.find((e) => e.id === id)?.processed_at ?? null;

  const chargeStatus = (booking: string) =>
    ds.charges.find((c) => c.booking_reference === booking)?.status ?? null;

  const lastError = (id: string) =>
    ds.events.find((e) => e.id === id)?.last_error ?? null;

  const seedCharge = () => {
    ds.charges.push({
      id: '00000000-0000-4000-8000-000000000001',
      booking_reference: BOOKING,
      idempotency_key: `booking:${BOOKING}:charge`,
      amount_piastres: 6955,
      currency: 'EGP',
      status: 'started',
      stripe_payment_method_id: null,
      stripe_payment_intent_id: 'pi_1',
    });
  };

  beforeEach(() => {
    vi.unstubAllEnvs();
    logs = [];
    ds = createFakeDataSource();
    vi.spyOn(Logger.prototype, 'log').mockImplementation(
      function (this: Logger, message?: string) {
        logs.push(String(message ?? ''));
      },
    );
    vi.spyOn(Logger.prototype, 'error').mockImplementation(
      (message?: string) => {
        logs.push(`error:${message ?? ''}`);
      },
    );
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    published = [];
    outbox = {
      append: vi.fn(async (_ctx: unknown, envelope: unknown) => {
        published.push(envelope);
      }),
    };

    const fakeManager = { query: ds.query };
    const fakeDataSource = {
      query: ds.query,
      transaction: async (fn: (manager: unknown) => Promise<unknown>) =>
        fn(fakeManager),
    };
    const fakeInitializer = {
      ensureInitialized: async () => fakeDataSource,
    };
    unitOfWork = new TypeOrmUnitOfWork(
      fakeInitializer as unknown as DataSourceInitializer,
    );
    service = new ChargeWebhookService(
      ds as unknown as DataSource,
      outbox,
      unitOfWork,
    );
  });

  it('records the event and returns before any processing happens', async () => {
    expect(await service.record(succeededEvent('evt_1', 'pi_1'))).toBe(
      'recorded',
    );

    expect(processedAt('evt_1')).toBeNull();
  });

  it('calls the same event id a duplicate', async () => {
    expect(await service.record(succeededEvent('evt_1', 'pi_1'))).toBe(
      'recorded',
    );
    expect(await service.record(succeededEvent('evt_1', 'pi_1'))).toBe(
      'duplicate',
    );
  });

  it('calls a second event id for the same object and type a duplicate', async () => {
    expect(await service.record(succeededEvent('evt_1', 'pi_1'))).toBe(
      'recorded',
    );
    expect(await service.record(succeededEvent('evt_2', 'pi_1'))).toBe(
      'duplicate',
    );
  });

  it('ignores a setup_intent event', async () => {
    expect(await service.record(setupIntentEvent('evt_3', 'si_1'))).toBe(
      'duplicate',
    );
  });

  it('publishes payment.charge.succeeded in the transaction that marks the charge succeeded', async () => {
    seedCharge();
    expect(await service.record(succeededEvent('evt_1', 'pi_1'))).toBe(
      'recorded',
    );

    expect(await service.processPending()).toBe(1);
    expect(published).toHaveLength(1);

    const envelope = published[0] as {
      type: string;
      payload: { amountPiastres: number };
    };
    expect(envelope.type).toBe('payment.charge.succeeded');
    expect(envelope.payload.amountPiastres).toBe(6955);
    expect(chargeStatus(BOOKING)).toBe('succeeded');
    expect(processedAt('evt_1')).not.toBeNull();
  });

  it('treats an amount that is not the locked total as an alarm, not a confirmation', async () => {
    seedCharge();
    expect(await service.record(succeededEvent('evt_1', 'pi_1', 7000))).toBe(
      'recorded',
    );
    expect(await service.processPending()).toBe(1);

    expect(published).toHaveLength(0);
    expect(chargeStatus(BOOKING)).not.toBe('succeeded');
    expect(lastError('evt_1')).toMatch(/amount/i);
  });

  it('keeps a succeeded charge succeeded when a late failure for an earlier attempt arrives', async () => {
    seedCharge();
    expect(await service.record(succeededEvent('evt_1', 'pi_1'))).toBe(
      'recorded',
    );
    expect(await service.processPending()).toBe(1);
    expect(chargeStatus(BOOKING)).toBe('succeeded');

    expect(await service.record(failedEvent('evt_2', 'pi_1'))).toBe(
      'recorded',
    );
    expect(await service.processPending()).toBe(1);

    expect(chargeStatus(BOOKING)).toBe('succeeded');
    expect(published).toHaveLength(1);
  });

  it('publishes once when the same event is processed twice', async () => {
    seedCharge();
    expect(await service.record(succeededEvent('evt_1', 'pi_1'))).toBe(
      'recorded',
    );
    expect(await service.processPending()).toBe(1);
    expect(published).toHaveLength(1);

    expect(await service.processPending()).toBe(0);
    expect(published).toHaveLength(1);
  });
});
