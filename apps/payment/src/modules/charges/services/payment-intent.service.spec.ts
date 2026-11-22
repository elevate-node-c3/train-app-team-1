import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorCode } from '@app/contracts';
import type { StripeService } from '../../cards/services/stripe.service.js';
import { PaymentIntentService } from './payment-intent.service.js';
import type { PaymentChargeRepository } from '../repositories/payment-charge.repository.js';
import type { ChargeCardRepository } from '../repositories/charge-card.repository.js';
import type { ChargeWebhookService } from './charge-webhook.service.js';
import type { Charge } from '../types/charge.types.js';
import type { PaymentIntentSnapshot } from '../types/payment-intent.types.js';

const BOOKING = '22222222-2222-4222-8222-222222222222';
const CHARGE = '00000000-0000-4000-8000-000000000001';
const intent = (
  overrides: Partial<PaymentIntentSnapshot> = {},
): PaymentIntentSnapshot => ({
  id: 'pi_1',
  clientSecret: 'pi_1_secret_sensitive',
  status: 'requires_confirmation',
  amount: 6955,
  amountReceived: 0,
  currency: 'egp',
  metadata: { bookingReference: BOOKING, paymentReference: CHARGE },
  ...overrides,
});

describe('PaymentIntentService durable recovery', () => {
  let row: Charge;
  let service: PaymentIntentService;
  let repository: ReturnType<typeof repositories>;
  let stripe: ReturnType<typeof stripeClient>;
  let cards: { findCustomerIdByPaymentMethodId: ReturnType<typeof vi.fn> };
  let webhooks: { recordVerifiedIntent: ReturnType<typeof vi.fn> };

  function repositories() {
    return {
      findByReference: vi.fn(async () => ({ ...row })),
      claimIntentCreation: vi.fn(
        async (_id: string, claim: string, customerId: string) => {
          if (
            row.stripePaymentIntentId ||
            row.status !== 'started' ||
            (row.intentCreationLeaseUntil &&
              row.intentCreationLeaseUntil.getTime() > Date.now())
          )
            return undefined;
          row.intentCreationStartedAt ??= new Date();
          row.intentCreationClaim = claim;
          row.intentCreationLeaseUntil = new Date(Date.now() + 30_000);
          row.stripeCustomerId ??= customerId;
          return { ...row };
        },
      ),
      completeIntentCreation: vi.fn(
        async (_id: string, claim: string, id: string) => {
          if (row.intentCreationClaim !== claim) throw new Error('claim lost');
          if (row.stripePaymentIntentId && row.stripePaymentIntentId !== id)
            throw new Error('mapping conflict');
          row.stripePaymentIntentId = id;
          row.intentCreationClaim = null;
          row.intentCreationLeaseUntil = null;
        },
      ),
      canReplayIntentCreation: vi.fn(
        async (_id: string, claim: string) =>
          row.intentCreationClaim === claim &&
          (row.intentCreationLeaseUntil?.getTime() ?? 0) > Date.now() &&
          (row.intentCreationStartedAt?.getTime() ?? 0) >
            Date.now() - 23 * 60 * 60 * 1_000,
      ),
      releaseIntentCreation: vi.fn(
        async (_id: string, claim: string, error: string) => {
          if (row.intentCreationClaim === claim) {
            row.intentCreationClaim = null;
            row.intentCreationLeaseUntil = new Date(Date.now() + 3_000);
            row.intentCreationLastError = error;
          }
        },
      ),
      requestCancellation: vi.fn(async () => {
        row.cancellationRequestedAt ??= new Date();
      }),
      cancelUnattempted: vi.fn(async () => {
        if (row.stripePaymentIntentId || row.intentCreationStartedAt)
          return false;
        row.status = 'cancelled';
        return true;
      }),
      cancelStarted: vi.fn(async () => {
        if (row.status !== 'started') return false;
        row.status = 'cancelled';
        return true;
      }),
      findRecoveryPending: vi.fn(async () => [{ ...row }]),
      deferRecovery: vi.fn(async () => undefined),
    };
  }

  function stripeClient() {
    return {
      createOrRetrievePaymentIntent: vi
        .fn<StripeService['createOrRetrievePaymentIntent']>()
        .mockResolvedValue(intent()),
      retrievePaymentIntent: vi
        .fn<StripeService['retrievePaymentIntent']>()
        .mockResolvedValue(intent()),
      findPaymentIntentsForBooking: vi
        .fn<StripeService['findPaymentIntentsForBooking']>()
        .mockResolvedValue([]),
      cancelPaymentIntent: vi
        .fn<StripeService['cancelPaymentIntent']>()
        .mockResolvedValue(intent({ status: 'canceled', clientSecret: '' })),
    };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-22T00:00:00Z'));
    row = {
      id: CHARGE,
      bookingReference: BOOKING,
      idempotencyKey: `booking:${BOOKING}:charge`,
      amountPiastres: 6955,
      currency: 'EGP',
      status: 'started',
      stripePaymentMethodId: null,
    };
    repository = repositories();
    stripe = stripeClient();
    cards = {
      findCustomerIdByPaymentMethodId: vi.fn().mockResolvedValue('cus_owned'),
    };
    webhooks = { recordVerifiedIntent: vi.fn().mockResolvedValue(undefined) };
    service = new PaymentIntentService(
      stripe as unknown as StripeService,
      repository as unknown as PaymentChargeRepository,
      cards as unknown as ChargeCardRepository,
      webhooks as unknown as ChargeWebhookService,
    );
  });

  afterEach(() => vi.useRealTimers());

  it('commits the creation claim and stable customer before issuing the request', async () => {
    row.stripePaymentMethodId = 'pm_owned';
    stripe.createOrRetrievePaymentIntent.mockImplementationOnce(async () => {
      expect(row.intentCreationStartedAt).toBeInstanceOf(Date);
      expect(row.intentCreationClaim).toBeTruthy();
      expect(row.stripeCustomerId).toBe('cus_owned');
      return intent();
    });
    expect((await service.startFor(row)).clientSecret).toBe(
      'pi_1_secret_sensitive',
    );
    expect(stripe.createOrRetrievePaymentIntent).toHaveBeenCalledWith({
      bookingReference: BOOKING,
      paymentReference: CHARGE,
      amountPiastres: 6955,
      currency: 'EGP',
      customerId: 'cus_owned',
      paymentMethodId: 'pm_owned',
      idempotencyKey: `booking:${BOOKING}:charge`,
    });
    expect(row.stripePaymentIntentId).toBe('pi_1');
  });

  it('retrieves a durable intent without resolving a removed saved card', async () => {
    row.stripePaymentIntentId = 'pi_1';
    row.stripePaymentMethodId = 'pm_removed';
    await service.startFor(row);
    expect(stripe.retrievePaymentIntent).toHaveBeenCalledWith('pi_1');
    expect(cards.findCustomerIdByPaymentMethodId).not.toHaveBeenCalled();
    expect(stripe.createOrRetrievePaymentIntent).not.toHaveBeenCalled();
  });

  it('allows only one concurrent creation owner', async () => {
    let release!: (value: PaymentIntentSnapshot) => void;
    stripe.createOrRetrievePaymentIntent.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const first = service.startFor({ ...row });
    await vi.waitFor(() =>
      expect(stripe.createOrRetrievePaymentIntent).toHaveBeenCalledTimes(1),
    );
    await expect(service.startFor({ ...row })).rejects.toMatchObject({
      code: ErrorCode.DEPENDENCY_UNAVAILABLE,
    });
    release(intent());
    await first;
    expect(stripe.createOrRetrievePaymentIntent).toHaveBeenCalledTimes(1);
  });

  it('recovers an orphan after the Stripe key expires, without recreating it', async () => {
    repository.completeIntentCreation.mockRejectedValueOnce(
      new Error('crash before saving intent'),
    );
    await expect(service.startFor(row)).rejects.toMatchObject({
      code: ErrorCode.DEPENDENCY_UNAVAILABLE,
    });
    vi.advanceTimersByTime(25 * 60 * 60 * 1_000);
    stripe.findPaymentIntentsForBooking.mockResolvedValue([intent()]);
    await service.startFor(row);
    expect(stripe.createOrRetrievePaymentIntent).toHaveBeenCalledTimes(1);
    expect(row.stripePaymentIntentId).toBe('pi_1');
  });

  it('never treats an empty eventually-consistent search after expiry as permission to create', async () => {
    row.intentCreationStartedAt = new Date(Date.now() - 24 * 60 * 60 * 1_000);
    await expect(service.startFor(row)).rejects.toMatchObject({
      code: ErrorCode.DEPENDENCY_UNAVAILABLE,
    });
    expect(stripe.createOrRetrievePaymentIntent).not.toHaveBeenCalled();
    expect(row.intentCreationLastError).toMatch(/expired/);
  });

  it('keeps retry parameters stable within the safe key window', async () => {
    row.stripePaymentMethodId = 'pm_owned';
    stripe.createOrRetrievePaymentIntent.mockRejectedValueOnce(
      new Error('request timed out'),
    );
    await expect(service.startFor(row)).rejects.toMatchObject({
      code: ErrorCode.DEPENDENCY_UNAVAILABLE,
    });
    const started = row.intentCreationStartedAt;
    cards.findCustomerIdByPaymentMethodId.mockResolvedValue('cus_changed');
    vi.advanceTimersByTime(3_001);
    await service.startFor(row);
    expect(stripe.createOrRetrievePaymentIntent.mock.calls[1]).toEqual(
      stripe.createOrRetrievePaymentIntent.mock.calls[0],
    );
    expect(row.intentCreationStartedAt).toBe(started);
  });

  it('fences a stale creation owner that resumes after the safe Stripe window', async () => {
    row.intentCreationStartedAt = new Date(Date.now() - 1_000);
    let release!: (value: PaymentIntentSnapshot[]) => void;
    stripe.findPaymentIntentsForBooking.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const resumed = service.startFor(row);
    await vi.waitFor(() =>
      expect(stripe.findPaymentIntentsForBooking).toHaveBeenCalledTimes(1),
    );
    vi.advanceTimersByTime(25 * 60 * 60 * 1_000);
    release([]);
    await expect(resumed).rejects.toMatchObject({
      code: ErrorCode.DEPENDENCY_UNAVAILABLE,
    });
    expect(stripe.createOrRetrievePaymentIntent).not.toHaveBeenCalled();
  });

  it('refuses ambiguous correlation rather than choosing an arbitrary intent', async () => {
    row.intentCreationStartedAt = new Date(Date.now() - 1_000);
    stripe.findPaymentIntentsForBooking.mockResolvedValue([
      intent(),
      intent({ id: 'pi_other' }),
    ]);
    await expect(service.startFor(row)).rejects.toMatchObject({
      code: ErrorCode.DEPENDENCY_UNAVAILABLE,
    });
    expect(row.intentCreationLastError).toMatch(/ambiguous/);
    expect(stripe.createOrRetrievePaymentIntent).not.toHaveBeenCalled();
  });

  it('cancels an unattempted charge without creating a remote intent', async () => {
    expect(await service.cancelFor(row)).toBe('CANCELLED');
    expect(row.status).toBe('cancelled');
    expect(stripe.createOrRetrievePaymentIntent).not.toHaveBeenCalled();
  });

  it('cancels Stripe before reporting cancellation and suppresses the secret', async () => {
    row.stripePaymentIntentId = 'pi_1';
    expect(await service.cancelFor(row)).toBe('CANCELLED');
    expect(stripe.cancelPaymentIntent).toHaveBeenCalledWith('pi_1', BOOKING);
    expect(row.status).toBe('cancelled');
    expect((await service.startFor(row)).clientSecret).toBe('');
  });

  it('recovers a browser confirmation that wins the cancellation race', async () => {
    row.stripePaymentIntentId = 'pi_1';
    stripe.retrievePaymentIntent
      .mockResolvedValueOnce(intent())
      .mockResolvedValueOnce(
        intent({ status: 'succeeded', amountReceived: 6955 }),
      );
    stripe.cancelPaymentIntent.mockRejectedValueOnce(
      new Error('already succeeded'),
    );
    expect(await service.cancelFor(row)).toBe('ALREADY_SUCCEEDED');
    expect(webhooks.recordVerifiedIntent).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: 'succeeded', amountReceived: 6955 }),
    );
    expect(repository.cancelStarted).not.toHaveBeenCalled();
  });

  it('does not report cancellation when Stripe is still processing', async () => {
    row.stripePaymentIntentId = 'pi_1';
    stripe.retrievePaymentIntent.mockResolvedValue(
      intent({ status: 'processing' }),
    );
    stripe.cancelPaymentIntent.mockRejectedValueOnce(
      new Error('cannot cancel yet'),
    );
    await expect(service.cancelFor(row)).rejects.toMatchObject({
      code: ErrorCode.DEPENDENCY_UNAVAILABLE,
    });
    expect(row.status).toBe('started');
    expect(row.cancellationRequestedAt).toBeTruthy();
  });

  it('records trusted retrieval success durably but never exposes its secret', async () => {
    row.stripePaymentIntentId = 'pi_1';
    stripe.retrievePaymentIntent.mockResolvedValue(
      intent({ status: 'succeeded', amountReceived: 6955 }),
    );
    expect(await service.startFor(row)).toMatchObject({
      status: 'succeeded',
      clientSecret: '',
    });
    expect(webhooks.recordVerifiedIntent).toHaveBeenCalled();
  });

  it('rejects short captures while retaining durable success evidence for investigation', async () => {
    row.stripePaymentIntentId = 'pi_1';
    stripe.retrievePaymentIntent.mockResolvedValue(
      intent({ status: 'succeeded', amountReceived: 3000 }),
    );
    await expect(service.startFor(row)).rejects.toMatchObject({
      code: ErrorCode.CONFLICT,
    });
    expect(webhooks.recordVerifiedIntent).toHaveBeenCalledWith(
      expect.objectContaining({ amountReceived: 3000 }),
    );
  });

  it.each(['cancelled', 'refunded', 'succeeded'] as const)(
    'never creates an intent or returns a secret for durable %s',
    async (status) => {
      row.status = status;
      expect((await service.startFor(row)).clientSecret).toBe('');
      expect(stripe.createOrRetrievePaymentIntent).not.toHaveBeenCalled();
      expect(stripe.retrievePaymentIntent).not.toHaveBeenCalled();
    },
  );

  it('background recovery discovers succeeded intents without requiring webhook redelivery', async () => {
    row.stripePaymentIntentId = 'pi_1';
    row.intentCreationStartedAt = new Date();
    stripe.retrievePaymentIntent.mockResolvedValue(
      intent({ status: 'succeeded', amountReceived: 6955 }),
    );
    await service.recoverPending();
    expect(webhooks.recordVerifiedIntent).toHaveBeenCalled();
    expect(repository.deferRecovery).toHaveBeenCalledWith(CHARGE, null);
  });
});
