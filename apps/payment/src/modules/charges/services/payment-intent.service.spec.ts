import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { Logger } from '@nestjs/common';
import { ErrorCode } from '@app/contracts';
import type { StripeService } from '../../cards/services/stripe.service.js';
import { PaymentIntentService } from './payment-intent.service.js';
import type { PaymentChargeRepository } from '../repositories/payment-charge.repository.js';
import type { ChargeCardRepository } from '../repositories/charge-card.repository.js';
import type { Charge } from '../types/charge.types.js';

const BOOKING = '22222222-2222-4222-8222-222222222222';

function charge(overrides: Partial<Charge> = {}): Charge {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    bookingReference: BOOKING,
    idempotencyKey: `booking:${BOOKING}:charge`,
    amountPiastres: 6955,
    currency: 'EGP',
    status: 'started',
    stripePaymentMethodId: null,
    ...overrides,
  };
}

describe('PaymentIntentService', () => {
  let charges: {
    savePaymentIntent: Mock<PaymentChargeRepository['savePaymentIntent']>;
  };
  let cards: {
    findCustomerIdByPaymentMethodId: Mock<
      ChargeCardRepository['findCustomerIdByPaymentMethodId']
    >;
  };
  let stripe: {
    createOrRetrievePaymentIntent: Mock<
      StripeService['createOrRetrievePaymentIntent']
    >;
    retrievePaymentIntent: Mock<StripeService['retrievePaymentIntent']>;
  };
  let service: PaymentIntentService;
  let logs: string[];

  beforeEach(() => {
    vi.unstubAllEnvs();
    logs = [];
    for (const level of ['log', 'error', 'warn', 'debug', 'verbose'] as const) {
      vi.spyOn(Logger.prototype, level).mockImplementation(
        (...messages: unknown[]) => {
          logs.push(JSON.stringify(messages));
        },
      );
    }

    charges = {
      savePaymentIntent: vi
        .fn<PaymentChargeRepository['savePaymentIntent']>()
        .mockResolvedValue(undefined),
    };
    cards = {
      findCustomerIdByPaymentMethodId: vi
        .fn<ChargeCardRepository['findCustomerIdByPaymentMethodId']>()
        .mockResolvedValue(undefined),
    };
    stripe = {
      createOrRetrievePaymentIntent: vi
        .fn<StripeService['createOrRetrievePaymentIntent']>()
        .mockResolvedValue({
          id: 'pi_new',
          clientSecret: 'pi_new_secret',
          status: 'requires_payment_method',
          amountReceived: null,
        }),
      retrievePaymentIntent: vi
        .fn<StripeService['retrievePaymentIntent']>()
        .mockResolvedValue({
          id: 'pi_existing',
          clientSecret: 'pi_existing_secret',
          status: 'succeeded',
          amountReceived: 6955,
        }),
    };
    service = new PaymentIntentService(
      stripe as unknown as StripeService,
      charges as unknown as PaymentChargeRepository,
      cards as unknown as ChargeCardRepository,
    );
  });

  it('creates the intent with the booking-derived idempotency key and the locked amount', async () => {
    const result = await service.startFor(charge());

    expect(stripe.createOrRetrievePaymentIntent).toHaveBeenCalledWith({
      bookingReference: BOOKING,
      amountPiastres: 6955,
      currency: 'EGP',
      customerId: '',
      paymentMethodId: '',
      idempotencyKey: `booking:${BOOKING}:charge`,
    });
    expect(result.paymentIntentId).toBe('pi_new');
    expect(result.clientSecret).toBe('pi_new_secret');
    expect(charges.savePaymentIntent).toHaveBeenCalledWith(BOOKING, 'pi_new');
    expect(cards.findCustomerIdByPaymentMethodId).not.toHaveBeenCalled();
  });

  it('retrieves the existing intent instead of creating a second one', async () => {
    const result = await service.startFor(
      charge({ stripePaymentIntentId: 'pi_existing' }),
    );

    expect(stripe.retrievePaymentIntent).toHaveBeenCalledWith('pi_existing');
    expect(stripe.createOrRetrievePaymentIntent).not.toHaveBeenCalled();
    expect(result.paymentIntentId).toBe('pi_existing');
    expect(charges.savePaymentIntent).not.toHaveBeenCalled();
    expect(cards.findCustomerIdByPaymentMethodId).not.toHaveBeenCalled();
  });

  it('retrieves an existing intent without resolving its saved card customer', async () => {
    const result = await service.startFor(
      charge({
        stripePaymentIntentId: 'pi_existing',
        stripePaymentMethodId: 'pm_deleted',
      }),
    );

    expect(result.paymentIntentId).toBe('pi_existing');
    expect(stripe.retrievePaymentIntent).toHaveBeenCalledWith('pi_existing');
    expect(stripe.createOrRetrievePaymentIntent).not.toHaveBeenCalled();
    expect(cards.findCustomerIdByPaymentMethodId).not.toHaveBeenCalled();
  });

  it('resolves the customer through the saved card payment method', async () => {
    cards.findCustomerIdByPaymentMethodId.mockResolvedValue('cus_owned');

    await service.startFor(
      charge({
        stripePaymentMethodId: 'pm_owned',
      }),
    );

    expect(cards.findCustomerIdByPaymentMethodId).toHaveBeenCalledWith(
      'pm_owned',
    );
    expect(stripe.createOrRetrievePaymentIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        customerId: 'cus_owned',
        paymentMethodId: 'pm_owned',
      }),
    );
    expect(charges.savePaymentIntent).toHaveBeenCalledWith(BOOKING, 'pi_new');
  });

  it('returns not found when the saved card customer cannot be resolved', async () => {
    await expect(
      service.startFor(
        charge({
          stripePaymentMethodId: 'pm_missing',
        }),
      ),
    ).rejects.toMatchObject({ code: ErrorCode.RESOURCE_NOT_FOUND });

    expect(cards.findCustomerIdByPaymentMethodId).toHaveBeenCalledWith(
      'pm_missing',
    );
    expect(stripe.createOrRetrievePaymentIntent).not.toHaveBeenCalled();
    expect(charges.savePaymentIntent).not.toHaveBeenCalled();
  });

  it('never puts the client secret in a log line', async () => {
    const created = await service.startFor(charge());
    const retrieved = await service.startFor(
      charge({
        stripePaymentIntentId: 'pi_existing',
      }),
    );

    expect(created.clientSecret).toBe('pi_new_secret');
    expect(retrieved.clientSecret).toBe('pi_existing_secret');
    expect(logs.join('\n')).not.toContain(created.clientSecret);
    expect(logs.join('\n')).not.toContain(retrieved.clientSecret);
    expect(logs.join('\n')).not.toContain('secret');
  });
});
