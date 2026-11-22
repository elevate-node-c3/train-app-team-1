import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DataSource } from 'typeorm';
import { ErrorCode } from '@app/contracts';
import { StripeService } from './stripe.service.js';

describe('StripeService', () => {
  let service: StripeService;
  let mockDataSource: {
    query: ReturnType<typeof vi.fn>;
    transaction: ReturnType<typeof vi.fn>;
  };

  const accountId = '11111111-1111-4111-8111-111111111111';

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  beforeEach(() => {
    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_validForStripeServiceTests123');
    const query = vi.fn();
    mockDataSource = {
      query,
      transaction: vi.fn(
        async (work: (manager: { query: typeof query }) => Promise<unknown>) =>
          work({ query }),
      ),
    };
    service = new StripeService(mockDataSource as unknown as DataSource);
  });

  it('returns existing stripe customer from database if present', async () => {
    mockDataSource.query
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ stripe_customer_id: 'cus_existing_123' }]);

    const customerId = await service.getOrCreateCustomer(accountId);
    expect(customerId).toBe('cus_existing_123');
    expect(mockDataSource.query).toHaveBeenNthCalledWith(
      2,
      'SELECT stripe_customer_id FROM payment_customer WHERE account_id = $1',
      [accountId],
    );
    expect(mockDataSource.query).toHaveBeenNthCalledWith(
      1,
      'SELECT pg_advisory_xact_lock(hashtext($1))',
      [accountId],
    );
    expect(mockDataSource.transaction).toHaveBeenCalledTimes(1);
  });

  it('trips circuit breaker after 5 failures and fails fast with DEPENDENCY_UNAVAILABLE', async () => {
    // Mock stripe customer create to fail
    const stripeMock = (service as any).stripeClient;
    stripeMock.customers = {
      create: vi.fn().mockRejectedValue(new Error('Stripe API unreachable')),
    };

    mockDataSource.query.mockResolvedValue([]); // not in DB

    // Trigger 5 failures
    for (let i = 0; i < 5; i++) {
      await expect(
        service.getOrCreateCustomer(accountId),
      ).rejects.toMatchObject({
        code: ErrorCode.DEPENDENCY_UNAVAILABLE,
        retryAfterSeconds: 30,
      });
    }

    // 6th call should immediately fast-fail via open circuit breaker without calling stripe
    stripeMock.customers.create.mockClear();
    await expect(service.getOrCreateCustomer(accountId)).rejects.toMatchObject({
      code: ErrorCode.DEPENDENCY_UNAVAILABLE,
      retryAfterSeconds: 30,
    });
    expect(stripeMock.customers.create).not.toHaveBeenCalled();
  });

  it('treats an already detached PaymentMethod as a successful retry', async () => {
    const stripeMock = (service as any).stripeClient;
    const detach = vi.fn();
    stripeMock.paymentMethods = {
      retrieve: vi
        .fn()
        .mockResolvedValue({ id: 'pm_detached', customer: null }),
      detach,
    };

    await expect(
      service.detachPaymentMethod('pm_detached', 'cus_expected'),
    ).resolves.toBeUndefined();
    expect(detach).not.toHaveBeenCalled();
  });

  it('creates browser-confirmable intents with durable correlation and stable key, without server confirmation', async () => {
    const stripeMock = (service as any).stripeClient;
    const create = vi.fn().mockResolvedValue({
      id: 'pi_1',
      status: 'requires_confirmation',
      client_secret: 'pi_1_secret_browser',
      amount: 6955,
      amount_received: 0,
      currency: 'egp',
      metadata: {},
    });
    stripeMock.paymentIntents = { create };
    await service.createOrRetrievePaymentIntent({
      bookingReference: accountId,
      paymentReference: 'charge_1',
      amountPiastres: 6955,
      currency: 'EGP',
      customerId: '',
      paymentMethodId: '',
      idempotencyKey: 'booking:key:charge',
    });
    expect(create).toHaveBeenCalledWith(
      {
        amount: 6955,
        currency: 'egp',
        metadata: { bookingReference: accountId, paymentReference: 'charge_1' },
        automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
      },
      { idempotencyKey: 'booking:key:charge' },
    );
    expect(create.mock.calls[0][0]).not.toHaveProperty('confirm');
  });

  it.each(['succeeded', 'canceled', 'processing'])(
    'never returns the secret for Stripe %s',
    async (status) => {
      const stripeMock = (service as any).stripeClient;
      stripeMock.paymentIntents = {
        retrieve: vi.fn().mockResolvedValue({
          id: 'pi_1',
          status,
          client_secret: 'pi_1_secret_sensitive',
          amount: 6955,
          amount_received: 6955,
          currency: 'egp',
          metadata: {},
        }),
      };
      expect(await service.retrievePaymentIntent('pi_1')).toMatchObject({
        clientSecret: '',
        status,
        amountReceived: 6955,
      });
    },
  );
});
