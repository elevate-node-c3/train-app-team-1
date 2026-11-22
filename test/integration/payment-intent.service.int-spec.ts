import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DataSource } from 'typeorm';
import { StripeService } from '../../apps/payment/src/modules/cards/services/stripe.service.js';
import { PaymentIntentService } from '../../apps/payment/src/modules/charges/services/payment-intent.service.js';
import { ChargeCardRepository } from '../../apps/payment/src/modules/charges/repositories/charge-card.repository.js';
import { PaymentChargeRepository } from '../../apps/payment/src/modules/charges/repositories/payment-charge.repository.js';
import { PaymentChargeEntity } from '../../apps/payment/src/modules/charges/entities/payment-charge.entity.js';
import { SavedCardEntity } from '../../apps/payment/src/modules/cards/entities/saved-card.entity.js';
import { ChargeWebhookService } from '../../apps/payment/src/modules/charges/services/charge-webhook.service.js';
import { StripeEventRepository } from '../../apps/payment/src/modules/charges/repositories/stripe-event.repository.js';
import { StripeEventEntity } from '../../apps/payment/src/modules/charges/entities/stripe-event.entity.js';
import { TypeOrmUnitOfWork } from '@app/common/persistence/typeorm-unit-of-work.js';
import { DataSourceInitializer } from '@app/common/persistence/data-source-initializer.js';
import { TypeOrmOutboxRepository } from '@app/messaging';
import type { Charge } from '../../apps/payment/src/modules/charges/types/charge.types.js';
import {
  closePaymentDataSource,
  paymentDataSource,
  truncatePayment,
} from './support/payment-database.js';

let source: DataSource;
let stripe: StripeService;
let service: PaymentIntentService;
let charges: PaymentChargeRepository;
let webhooks: ChargeWebhookService;
let client: {
  create: ReturnType<typeof vi.fn>;
  retrieve: ReturnType<typeof vi.fn>;
  search: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
};

beforeEach(async () => {
  source = await paymentDataSource();
  await truncatePayment(source);

  vi.unstubAllEnvs();
  vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_validForPaymentIntentServiceTests');
  stripe = new StripeService(source);
  const stripeMock = (stripe as unknown as { stripeClient: unknown })
    .stripeClient as { paymentIntents: typeof client };
  stripeMock.paymentIntents = {
    create: vi
      .fn()
      .mockImplementation(async (params: Record<string, unknown>) => ({
        id: 'pi_new',
        client_secret: 'pi_new_secret',
        status: 'requires_payment_method',
        amount_received: 0,
        amount: 6955,
        currency: 'egp',
        metadata: params.metadata,
      })),
    retrieve: vi.fn().mockResolvedValue({
      id: 'pi_existing',
      client_secret: 'pi_existing_secret',
      status: 'succeeded',
      amount_received: 6955,
      amount: 6955,
      currency: 'egp',
      metadata: {},
    }),
    search: vi.fn().mockResolvedValue({ data: [] }),
    cancel: vi.fn().mockResolvedValue({
      id: 'pi_1',
      status: 'canceled',
      amount: 6955,
      amount_received: 0,
      currency: 'egp',
      metadata: {},
    }),
  };
  client = stripeMock.paymentIntents;
  charges = new PaymentChargeRepository(
    source.getRepository(PaymentChargeEntity),
  );
  const initializer = new DataSourceInitializer(source);
  webhooks = new ChargeWebhookService(
    charges,
    new StripeEventRepository(source.getRepository(StripeEventEntity)),
    new TypeOrmOutboxRepository(initializer),
    new TypeOrmUnitOfWork(initializer),
  );
  service = new PaymentIntentService(
    stripe,
    charges,
    new ChargeCardRepository(source.getRepository(SavedCardEntity)),
    webhooks,
  );
});

afterAll(async () => {
  await closePaymentDataSource();
});

describe('PaymentIntentService.startFor against the real payment schema', () => {
  async function givenCharge(): Promise<Charge> {
    const bookingReference = randomUUID();
    await charges.createStarted({
      id: randomUUID(),
      bookingReference,
      idempotencyKey: `booking:${bookingReference}:charge`,
      amountPiastres: 6955,
      currency: 'EGP',
      cardBrand: null,
      cardLast4: null,
      stripePaymentMethodId: null,
    });
    return (await charges.findByBookingOrKey(
      bookingReference,
      `booking:${bookingReference}:charge`,
    ))!;
  }
  it('persists the new intent id without referencing a column payment_charge does not have', async () => {
    const chargeId = randomUUID();
    const booking = randomUUID();
    await source.query(
      `INSERT INTO payment_charge
         (id, booking_reference, idempotency_key, amount_piastres, currency, status)
       VALUES ($1, $2, $3, 6955, 'EGP', 'started')`,
      [chargeId, booking, `booking:${booking}:charge`],
    );

    await expect(
      service.startFor({
        id: chargeId,
        bookingReference: booking,
        idempotencyKey: `booking:${booking}:charge`,
        amountPiastres: 6955,
        currency: 'EGP',
        status: 'started',
        stripePaymentMethodId: null,
      }),
    ).resolves.toMatchObject({ paymentIntentId: 'pi_new' });

    const [row]: { stripe_payment_intent_id: string }[] = await source.query(
      `SELECT stripe_payment_intent_id FROM payment_charge WHERE id = $1`,
      [chargeId],
    );
    expect(row.stripe_payment_intent_id).toBe('pi_new');
    expect(client.create).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: { bookingReference: booking, paymentReference: chargeId },
      }),
      expect.anything(),
    );
    expect(client.create.mock.calls[0][0]).not.toHaveProperty('confirm');
    expect(client.create.mock.calls[0][0]).not.toHaveProperty('customer');
  });

  it("resolves the saved card's real Stripe customer id, never an empty string", async () => {
    const chargeId = randomUUID();
    const booking = randomUUID();
    const accountId = randomUUID();
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
      [randomUUID(), accountId],
    );
    await source.query(
      `INSERT INTO payment_charge
         (id, booking_reference, idempotency_key, amount_piastres, currency,
          status, stripe_payment_method_id)
       VALUES ($1, $2, $3, 6955, 'EGP', 'started', 'pm_real')`,
      [chargeId, booking, `booking:${booking}:charge`],
    );

    await service.startFor({
      id: chargeId,
      bookingReference: booking,
      idempotencyKey: `booking:${booking}:charge`,
      amountPiastres: 6955,
      currency: 'EGP',
      status: 'started',
      stripePaymentMethodId: 'pm_real',
    });

    expect(client.create).toHaveBeenCalledWith(
      expect.objectContaining({
        customer: 'cus_real',
        payment_method: 'pm_real',
      }),
      expect.anything(),
    );
  });

  it('serializes concurrent requests with a committed creation lease', async () => {
    const charge = await givenCharge();
    let release!: (value: unknown) => void;
    client.create.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const first = service.startFor(charge);
    await vi.waitFor(() => expect(client.create).toHaveBeenCalledTimes(1));
    const claimed = await charges.findByReference(
      charge.id,
      charge.bookingReference,
    );
    expect(claimed?.intentCreationStartedAt).toBeInstanceOf(Date);
    expect(claimed?.intentCreationClaim).toBeTruthy();
    await expect(service.startFor(charge)).rejects.toMatchObject({
      code: 'DEPENDENCY_UNAVAILABLE',
    });
    release({
      id: 'pi_new',
      client_secret: 'pi_new_secret',
      status: 'requires_confirmation',
      amount: 6955,
      amount_received: 0,
      currency: 'egp',
      metadata: {
        bookingReference: charge.bookingReference,
        paymentReference: charge.id,
      },
    });
    await first;
    expect(client.create).toHaveBeenCalledTimes(1);
  });

  it('recovers a crash after Stripe creation beyond key expiry without a second create', async () => {
    const charge = await givenCharge();
    vi.spyOn(charges, 'completeIntentCreation').mockRejectedValueOnce(
      new Error('simulated crash before mapping'),
    );
    await expect(service.startFor(charge)).rejects.toMatchObject({
      code: 'DEPENDENCY_UNAVAILABLE',
    });
    await source.query(
      `UPDATE payment_charge SET intent_creation_started_at = now() - interval '25 hours',
      intent_creation_lease_until = NULL WHERE id = $1`,
      [charge.id],
    );
    client.search.mockResolvedValueOnce({
      data: [
        {
          id: 'pi_new',
          client_secret: 'pi_new_secret',
          status: 'requires_confirmation',
          amount: 6955,
          amount_received: 0,
          currency: 'egp',
          metadata: {
            bookingReference: charge.bookingReference,
            paymentReference: charge.id,
          },
        },
      ],
    });
    await service.startFor(charge);
    expect(client.create).toHaveBeenCalledTimes(1);
    expect(
      (await charges.findByReference(charge.id, charge.bookingReference))
        ?.stripePaymentIntentId,
    ).toBe('pi_new');
  });

  it('refuses blind recreation after expiry when Stripe reconciliation cannot find an orphan', async () => {
    const charge = await givenCharge();
    await source.query(
      `UPDATE payment_charge SET intent_creation_started_at = now() - interval '25 hours' WHERE id = $1`,
      [charge.id],
    );
    await expect(service.startFor(charge)).rejects.toMatchObject({
      code: 'DEPENDENCY_UNAVAILABLE',
    });
    expect(client.create).not.toHaveBeenCalled();
    expect(
      (await charges.findByReference(charge.id, charge.bookingReference))
        ?.intentCreationLastError,
    ).toMatch(/expired/);
  });

  it('uses authoritative retrieve success to durably recover a lost webhook during cancellation', async () => {
    const charge = await givenCharge();
    await charges.savePaymentIntent(charge.bookingReference, 'pi_existing');
    expect(await service.cancelFor(charge)).toBe('ALREADY_SUCCEEDED');
    expect(client.cancel).not.toHaveBeenCalled();
    expect(await webhooks.processPending()).toBe(1);
    expect(await charges.findStatus(charge.id, charge.bookingReference)).toBe(
      'succeeded',
    );
    expect(await source.query('SELECT id FROM outbox_event')).toHaveLength(1);
  });

  it('background recovery includes legacy mapped intents with no creation timestamp', async () => {
    const charge = await givenCharge();
    await charges.savePaymentIntent(charge.bookingReference, 'pi_existing');
    expect(
      (await charges.findByReference(charge.id, charge.bookingReference))
        ?.intentCreationStartedAt,
    ).toBeNull();
    await service.recoverPending();
    expect(client.retrieve).toHaveBeenCalledWith('pi_existing');
    expect(await webhooks.processPending()).toBe(1);
    expect(await charges.findStatus(charge.id, charge.bookingReference)).toBe(
      'succeeded',
    );
    expect(await source.query('SELECT id FROM outbox_event')).toHaveLength(1);
  });

  it('confirms real Stripe cancellation before changing local status', async () => {
    const charge = await givenCharge();
    await charges.savePaymentIntent(charge.bookingReference, 'pi_1');
    client.retrieve.mockResolvedValue({
      id: 'pi_1',
      client_secret: 'pi_1_secret',
      status: 'requires_confirmation',
      amount: 6955,
      amount_received: 0,
      currency: 'egp',
      metadata: {},
    });
    expect(await service.cancelFor(charge)).toBe('CANCELLED');
    expect(client.cancel).toHaveBeenCalledWith(
      'pi_1',
      {},
      { idempotencyKey: `booking:${charge.bookingReference}:cancel` },
    );
    expect(await charges.findStatus(charge.id, charge.bookingReference)).toBe(
      'cancelled',
    );
    expect((await service.startFor(charge)).clientSecret).toBe('');
  });
});
