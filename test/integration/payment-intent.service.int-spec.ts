import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DataSource } from 'typeorm';
import { StripeService } from '../../apps/payment/src/modules/cards/services/stripe.service.js';
import { PaymentIntentService } from '../../apps/payment/src/modules/charges/services/payment-intent.service.js';
import { ChargeCardRepository } from '../../apps/payment/src/modules/charges/repositories/charge-card.repository.js';
import { PaymentChargeRepository } from '../../apps/payment/src/modules/charges/repositories/payment-charge.repository.js';
import { PaymentChargeEntity } from '../../apps/payment/src/modules/charges/entities/payment-charge.entity.js';
import { SavedCardEntity } from '../../apps/payment/src/modules/cards/entities/saved-card.entity.js';
import {
  closePaymentDataSource,
  paymentDataSource,
  truncatePayment,
} from './support/payment-database.js';

let source: DataSource;
let stripe: StripeService;
let service: PaymentIntentService;
let client: {
  create: ReturnType<typeof vi.fn>;
  retrieve: ReturnType<typeof vi.fn>;
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
    create: vi.fn().mockResolvedValue({
      id: 'pi_new',
      client_secret: 'pi_new_secret',
      status: 'requires_payment_method',
      amount_received: null,
    }),
    retrieve: vi.fn().mockResolvedValue({
      id: 'pi_existing',
      client_secret: 'pi_existing_secret',
      status: 'succeeded',
      amount_received: 6955,
    }),
  };
  client = stripeMock.paymentIntents;
  service = new PaymentIntentService(
    stripe,
    new PaymentChargeRepository(source.getRepository(PaymentChargeEntity)),
    new ChargeCardRepository(source.getRepository(SavedCardEntity)),
  );
});

afterAll(async () => {
  await closePaymentDataSource();
});

describe('PaymentIntentService.startFor against the real payment schema', () => {
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
});
