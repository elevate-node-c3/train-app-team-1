import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { Logger } from '@nestjs/common';
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

interface PendingStripeEvent extends StripeEventRecord {
  processedAt: string | null;
  lastError: string | null;
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

function createRepositories() {
  const events: PendingStripeEvent[] = [];
  const charges: Charge[] = [];

  const eventRepository = {
    record: vi.fn<StripeEventRepository['record']>(async (event) => {
      const duplicate = events.some(
        (e) =>
          e.id === event.id ||
          (e.objectId === event.objectId && e.type === event.type),
      );
      if (duplicate) return false;
      events.push({
        ...event,
        processedAt: null,
        lastError: null,
      });
      return true;
    }),
    findPending: vi.fn<StripeEventRepository['findPending']>(async (limit) =>
      events
        .filter((e) => e.processedAt === null)
        .slice(0, limit)
        .map(({ id, type, objectId, payload }) => ({
          id,
          type,
          objectId,
          payload,
        })),
    ),
    markRejected: vi.fn<StripeEventRepository['markRejected']>(
      async (id, error) => {
        const event = events.find((e) => e.id === id);
        if (event) {
          event.processedAt = new Date().toISOString();
          event.lastError = error;
        }
      },
    ),
    markProcessed: vi.fn<StripeEventRepository['markProcessed']>(async (id) => {
      const event = events.find((e) => e.id === id);
      if (event) event.processedAt = new Date().toISOString();
    }),
  };
  const chargeRepository = {
    findByPaymentIntentId: vi.fn<
      PaymentChargeRepository['findByPaymentIntentId']
    >(async (intentId) =>
      charges.find((charge) => charge.stripePaymentIntentId === intentId),
    ),
    markSucceeded: vi.fn<PaymentChargeRepository['markSucceeded']>(
      async (id) => {
        const charge = charges.find((c) => c.id === id);
        if (charge) charge.status = 'succeeded';
      },
    ),
  };

  return { eventRepository, chargeRepository, events, charges };
}

describe('ChargeWebhookService', () => {
  let repositories: ReturnType<typeof createRepositories>;
  let outbox: {
    append: Mock<OutboxPort['append']>;
    appendBatch: Mock<OutboxPort['appendBatch']>;
  };
  let service: ChargeWebhookService;
  let published: unknown[];
  let unitOfWork: { withTransaction: Mock<UnitOfWorkPort['withTransaction']> };
  let transactionContext: TransactionContext;

  const processedAt = (id: string) =>
    repositories.events.find((e) => e.id === id)?.processedAt ?? null;

  const chargeStatus = (booking: string) =>
    repositories.charges.find((c) => c.bookingReference === booking)?.status ??
    null;

  const lastError = (id: string) =>
    repositories.events.find((e) => e.id === id)?.lastError ?? null;

  const seedCharge = () => {
    repositories.charges.push({
      id: '00000000-0000-4000-8000-000000000001',
      bookingReference: BOOKING,
      idempotencyKey: `booking:${BOOKING}:charge`,
      amountPiastres: 6955,
      currency: 'EGP',
      status: 'started',
      stripePaymentMethodId: null,
      stripePaymentIntentId: 'pi_1',
    });
  };

  beforeEach(() => {
    vi.unstubAllEnvs();
    repositories = createRepositories();
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    published = [];
    outbox = {
      append: vi.fn<OutboxPort['append']>(async (_ctx, envelope) => {
        published.push(envelope);
      }),
      appendBatch: vi
        .fn<OutboxPort['appendBatch']>()
        .mockResolvedValue(undefined),
    };

    transactionContext = { driver: 'unit-test' };
    const withTransaction = async <T>(
      work: (ctx: TransactionContext) => Promise<T>,
    ) => work(transactionContext);
    unitOfWork = {
      withTransaction: vi.fn(withTransaction),
    };
    service = new ChargeWebhookService(
      repositories.chargeRepository as unknown as PaymentChargeRepository,
      repositories.eventRepository as unknown as StripeEventRepository,
      outbox,
      unitOfWork as unknown as UnitOfWorkPort,
    );
  });

  it('records the event and returns before any processing happens', async () => {
    const event = succeededEvent('evt_1', 'pi_1');
    expect(await service.record(event)).toBe('recorded');

    expect(processedAt('evt_1')).toBeNull();
    expect(repositories.eventRepository.record).toHaveBeenCalledWith({
      id: 'evt_1',
      type: 'payment_intent.succeeded',
      objectId: 'pi_1',
      payload: event.data.object,
    });
    expect(
      repositories.chargeRepository.findByPaymentIntentId,
    ).not.toHaveBeenCalled();
    expect(repositories.eventRepository.markProcessed).not.toHaveBeenCalled();
    expect(outbox.append).not.toHaveBeenCalled();
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
    expect(repositories.eventRepository.record).not.toHaveBeenCalled();
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
    expect(repositories.eventRepository.findPending).toHaveBeenCalledWith(50);
    expect(
      repositories.chargeRepository.findByPaymentIntentId,
    ).toHaveBeenCalledWith('pi_1');
    expect(unitOfWork.withTransaction).toHaveBeenCalledTimes(1);
    expect(repositories.chargeRepository.markSucceeded).toHaveBeenCalledWith(
      repositories.charges[0].id,
      transactionContext,
    );
    expect(outbox.append).toHaveBeenCalledWith(transactionContext, envelope);
    expect(repositories.eventRepository.markProcessed).toHaveBeenCalledWith(
      'evt_1',
      transactionContext,
    );
    expect(repositories.chargeRepository.markSucceeded.mock.calls[0][1]).toBe(
      transactionContext,
    );
    expect(outbox.append.mock.calls[0][0]).toBe(transactionContext);
    expect(repositories.eventRepository.markProcessed.mock.calls[0][1]).toBe(
      transactionContext,
    );
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
    expect(repositories.eventRepository.markRejected).toHaveBeenCalledWith(
      'evt_1',
      expect.stringMatching(/amount/i),
    );
    expect(repositories.chargeRepository.markSucceeded).not.toHaveBeenCalled();
    expect(unitOfWork.withTransaction).not.toHaveBeenCalled();
  });

  it('keeps a succeeded charge succeeded when a late failure for an earlier attempt arrives', async () => {
    seedCharge();
    expect(await service.record(succeededEvent('evt_1', 'pi_1'))).toBe(
      'recorded',
    );
    expect(await service.processPending()).toBe(1);
    expect(chargeStatus(BOOKING)).toBe('succeeded');

    expect(await service.record(failedEvent('evt_2', 'pi_1'))).toBe('recorded');
    expect(await service.processPending()).toBe(1);

    expect(chargeStatus(BOOKING)).toBe('succeeded');
    expect(published).toHaveLength(1);
    expect(repositories.eventRepository.markProcessed).toHaveBeenLastCalledWith(
      'evt_2',
    );
    expect(repositories.chargeRepository.markSucceeded).toHaveBeenCalledTimes(
      1,
    );
    expect(unitOfWork.withTransaction).toHaveBeenCalledTimes(1);
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
    expect(repositories.chargeRepository.markSucceeded).toHaveBeenCalledTimes(
      1,
    );
    expect(repositories.eventRepository.markProcessed).toHaveBeenCalledTimes(1);
  });

  it('propagates an outbox failure and leaves the event pending for retry', async () => {
    seedCharge();
    await service.record(succeededEvent('evt_1', 'pi_1'));
    const error = new Error('Outbox unavailable');
    outbox.append.mockRejectedValueOnce(error);

    await expect(service.processPending()).rejects.toBe(error);

    expect(processedAt('evt_1')).toBeNull();
    expect(lastError('evt_1')).toBeNull();
    expect(repositories.eventRepository.markProcessed).not.toHaveBeenCalled();
    expect(repositories.eventRepository.markRejected).not.toHaveBeenCalled();
    expect(published).toHaveLength(0);

    expect(await service.processPending()).toBe(1);
    expect(processedAt('evt_1')).not.toBeNull();
    expect(published).toHaveLength(1);
  });
});
