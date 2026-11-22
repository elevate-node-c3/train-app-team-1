import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { PaymentIntentService } from './payment-intent.service.js';
import { PaymentDoubleService } from './payment-double.service.js';
import type { PaymentChargeRepository } from '../repositories/payment-charge.repository.js';
import type { ChargeCardRepository } from '../repositories/charge-card.repository.js';
import type {
  ChargeCard,
  Charge,
  CreateChargeInput,
} from '../types/charge.types.js';

describe('PaymentDoubleService', () => {
  let charges: {
    findByBookingOrKey: Mock<PaymentChargeRepository['findByBookingOrKey']>;
    createStarted: Mock<PaymentChargeRepository['createStarted']>;
    markStartedSucceeded: Mock<PaymentChargeRepository['markStartedSucceeded']>;
    cancelStarted: Mock<PaymentChargeRepository['cancelStarted']>;
    findStatus: Mock<PaymentChargeRepository['findStatus']>;
    findByReference: Mock<PaymentChargeRepository['findByReference']>;
  };
  let cards: {
    findOwned: Mock<ChargeCardRepository['findOwned']>;
    markUsed: Mock<ChargeCardRepository['markUsed']>;
  };
  let intents: {
    startFor: Mock<PaymentIntentService['startFor']>;
    cancelFor: Mock<PaymentIntentService['cancelFor']>;
  };
  let payment: PaymentDoubleService;
  let savedCards: Array<
    ChargeCard & {
      id: string;
      accountId: string;
    }
  >;
  let savedCharge:
    (Charge & Pick<CreateChargeInput, 'cardBrand' | 'cardLast4'>) | undefined;

  beforeEach(() => {
    vi.unstubAllEnvs();
    savedCards = [];
    savedCharge = undefined;
    charges = {
      findByReference: vi.fn<PaymentChargeRepository['findByReference']>(
        async (id, bookingReference) =>
          savedCharge?.id === id &&
          savedCharge.bookingReference === bookingReference
            ? { ...savedCharge }
            : undefined,
      ),
      findByBookingOrKey: vi.fn<PaymentChargeRepository['findByBookingOrKey']>(
        async (bookingReference, idempotencyKey) =>
          savedCharge &&
          (savedCharge.bookingReference === bookingReference ||
            savedCharge.idempotencyKey === idempotencyKey)
            ? { ...savedCharge }
            : undefined,
      ),
      createStarted: vi.fn<PaymentChargeRepository['createStarted']>(
        async (input) => {
          if (!savedCharge) {
            savedCharge = {
              id: '00000000-0000-4000-8000-000000000001',
              bookingReference: input.bookingReference,
              idempotencyKey: input.idempotencyKey,
              amountPiastres: input.amountPiastres,
              currency: input.currency,
              status: 'started',
              cardBrand: input.cardBrand,
              cardLast4: input.cardLast4,
              stripePaymentMethodId: input.stripePaymentMethodId,
            };
          }
        },
      ),
      markStartedSucceeded: vi.fn<
        PaymentChargeRepository['markStartedSucceeded']
      >(async (id) => {
        if (savedCharge?.id === id && savedCharge.status === 'started') {
          savedCharge.status = 'succeeded';
        }
      }),
      cancelStarted: vi.fn<PaymentChargeRepository['cancelStarted']>(
        async (id, bookingReference) => {
          if (
            savedCharge?.id === id &&
            savedCharge.bookingReference === bookingReference &&
            savedCharge.status === 'started'
          ) {
            savedCharge.status = 'cancelled';
            return true;
          }
          return false;
        },
      ),
      findStatus: vi.fn<PaymentChargeRepository['findStatus']>(
        async (id, bookingReference) =>
          savedCharge?.id === id &&
          savedCharge.bookingReference === bookingReference
            ? savedCharge.status
            : undefined,
      ),
    };
    cards = {
      findOwned: vi.fn<ChargeCardRepository['findOwned']>(
        async (cardId, accountId) =>
          savedCards.find(
            (card) => card.id === cardId && card.accountId === accountId,
          ),
      ),
      markUsed: vi
        .fn<ChargeCardRepository['markUsed']>()
        .mockResolvedValue(undefined),
    };
    intents = {
      cancelFor: vi.fn<PaymentIntentService['cancelFor']>(async (charge) => {
        if (charge.status === 'succeeded') return 'ALREADY_SUCCEEDED';
        await charges.cancelStarted(charge.id, charge.bookingReference);
        return 'CANCELLED';
      }),
      startFor: vi.fn<PaymentIntentService['startFor']>().mockResolvedValue({
        paymentIntentId: 'pi_new',
        clientSecret: 'pi_new_secret',
        status: 'requires_payment_method',
      }),
    };
    payment = new PaymentDoubleService(
      charges as unknown as PaymentChargeRepository,
      cards as unknown as ChargeCardRepository,
      intents as unknown as PaymentIntentService,
    );
  });

  const startRequest = {
    bookingReference: '00000000-0000-4000-8000-000000000002',
    amountPiastres: 13_500,
    currency: 'EGP',
    idempotencyKey: 'booking:test:charge',
    accountId: '00000000-0000-4000-8000-000000000003',
  };

  it('returns the original charge for a repeated start key', async () => {
    const first = await payment.start(startRequest);
    const second = await payment.start(startRequest);

    expect(second).toEqual(first);
    expect(first.paymentReference).toBe('00000000-0000-4000-8000-000000000001');
    expect(charges.createStarted).toHaveBeenCalledTimes(1);
    expect(charges.findByBookingOrKey).toHaveBeenCalledTimes(3);
    expect(charges.findByBookingOrKey).toHaveBeenCalledWith(
      startRequest.bookingReference,
      startRequest.idempotencyKey,
    );
    expect(intents.startFor).toHaveBeenCalledTimes(2);
  });

  it('treats a repeated cancellation as successful', async () => {
    const charge = await payment.start(startRequest);
    const request = {
      bookingReference: startRequest.bookingReference,
      paymentReference: charge.paymentReference,
      idempotencyKey: 'booking:test:cancel',
    };

    expect(await payment.cancel(request)).toEqual({ status: 'CANCELLED' });
    expect(await payment.cancel(request)).toEqual({ status: 'CANCELLED' });
    expect(charges.cancelStarted).toHaveBeenCalledTimes(2);
    expect(charges.cancelStarted).toHaveBeenCalledWith(
      charge.paymentReference,
      startRequest.bookingReference,
    );
    expect(intents.cancelFor).toHaveBeenCalledTimes(2);
  });

  it('reports an already-succeeded charge rather than cancelling it', async () => {
    const charge = await payment.start(startRequest);
    savedCharge!.status = 'succeeded';

    expect(
      await payment.cancel({
        bookingReference: startRequest.bookingReference,
        paymentReference: charge.paymentReference,
        idempotencyKey: 'booking:test:cancel',
      }),
    ).toEqual({ status: 'ALREADY_SUCCEEDED' });
    expect(charges.markStartedSucceeded).not.toHaveBeenCalled();
    expect(savedCharge?.status).toBe('succeeded');
  });

  it('does not let the old test-double environment forge success', async () => {
    vi.stubEnv(
      'PAYMENT_DOUBLE_SUCCEEDED_BOOKINGS',
      startRequest.bookingReference,
    );
    expect((await payment.start(startRequest)).status).toBe('STARTED');
    expect(charges.markStartedSucceeded).not.toHaveBeenCalled();
    expect(savedCharge?.status).toBe('started');
  });

  it.each(['cancelled', 'refunded', 'succeeded'] as const)(
    'replays %s without exposing a secret or starting an intent',
    async (status) => {
      await payment.start(startRequest);
      savedCharge!.status = status;
      intents.startFor.mockClear();
      expect(await payment.start(startRequest)).toMatchObject({
        status: status.toUpperCase(),
        clientSecret: '',
      });
      expect(intents.startFor).not.toHaveBeenCalled();
    },
  );

  it('suppresses the secret while cancellation is durable but not yet complete', async () => {
    await payment.start(startRequest);
    savedCharge!.cancellationRequestedAt = new Date();
    expect(await payment.start(startRequest)).toMatchObject({
      status: 'STARTED',
      clientSecret: '',
    });
  });

  it('charges only an owned, active saved card and snapshots its payment details', async () => {
    savedCards.push({
      id: '00000000-0000-4000-8000-000000000004',
      accountId: startRequest.accountId,
      stripePaymentMethodId: 'pm_owned',
      brand: 'visa',
      last4: '4242',
      expMonth: 12,
      expYear: new Date().getUTCFullYear() + 1,
      status: 'active',
    });

    await payment.start({
      ...startRequest,
      savedCardId: '00000000-0000-4000-8000-000000000004',
    });

    expect(savedCharge).toMatchObject({
      cardBrand: 'visa',
      cardLast4: '4242',
      stripePaymentMethodId: 'pm_owned',
    });
    expect(charges.createStarted).toHaveBeenCalledWith({
      id: expect.any(String),
      bookingReference: startRequest.bookingReference,
      idempotencyKey: startRequest.idempotencyKey,
      amountPiastres: startRequest.amountPiastres,
      currency: startRequest.currency,
      cardBrand: 'visa',
      cardLast4: '4242',
      stripePaymentMethodId: 'pm_owned',
    });
    expect(cards.findOwned).toHaveBeenCalledWith(
      '00000000-0000-4000-8000-000000000004',
      startRequest.accountId,
    );
    expect(cards.markUsed).toHaveBeenCalledWith(
      '00000000-0000-4000-8000-000000000004',
      startRequest.accountId,
    );
  });

  it('returns not found for a card owned by another traveller', async () => {
    savedCards.push({
      id: '00000000-0000-4000-8000-000000000004',
      accountId: '00000000-0000-4000-8000-000000000005',
      stripePaymentMethodId: 'pm_foreign',
      brand: 'visa',
      last4: '4242',
      expMonth: 12,
      expYear: new Date().getUTCFullYear() + 1,
      status: 'active',
    });

    await expect(
      payment.start({
        ...startRequest,
        savedCardId: '00000000-0000-4000-8000-000000000004',
      }),
    ).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    expect(savedCharge).toBeUndefined();
    expect(charges.createStarted).not.toHaveBeenCalled();
    expect(cards.markUsed).not.toHaveBeenCalled();
  });

  it('refuses an expired saved card', async () => {
    savedCards.push({
      id: '00000000-0000-4000-8000-000000000004',
      accountId: startRequest.accountId,
      stripePaymentMethodId: 'pm_expired',
      brand: 'visa',
      last4: '4242',
      expMonth: 1,
      expYear: new Date().getUTCFullYear() - 1,
      status: 'active',
    });

    await expect(
      payment.start({
        ...startRequest,
        savedCardId: '00000000-0000-4000-8000-000000000004',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_PAYLOAD' });
    expect(savedCharge).toBeUndefined();
    expect(charges.createStarted).not.toHaveBeenCalled();
    expect(cards.markUsed).not.toHaveBeenCalled();
  });

  it('replays a started payment after its saved card has been deleted', async () => {
    savedCards.push({
      id: '00000000-0000-4000-8000-000000000004',
      accountId: startRequest.accountId,
      stripePaymentMethodId: 'pm_owned',
      brand: 'visa',
      last4: '4242',
      expMonth: 12,
      expYear: new Date().getUTCFullYear() + 1,
      status: 'active',
    });
    const request = {
      ...startRequest,
      savedCardId: '00000000-0000-4000-8000-000000000004',
    };
    const first = await payment.start(request);
    savedCards[0].status = 'detached';

    await expect(payment.start(request)).resolves.toEqual(first);
    expect(charges.createStarted).toHaveBeenCalledTimes(1);
    expect(cards.markUsed).toHaveBeenCalledTimes(1);
    expect(intents.startFor).toHaveBeenCalledTimes(2);
  });

  it('still returns 404 for a foreign card when the booking already has a charge', async () => {
    savedCards.push(
      {
        id: '00000000-0000-4000-8000-000000000004',
        accountId: startRequest.accountId,
        stripePaymentMethodId: 'pm_owned',
        brand: 'visa',
        last4: '4242',
        expMonth: 12,
        expYear: new Date().getUTCFullYear() + 1,
        status: 'active',
      },
      {
        id: '00000000-0000-4000-8000-000000000005',
        accountId: '00000000-0000-4000-8000-000000000006',
        stripePaymentMethodId: 'pm_foreign',
        brand: 'visa',
        last4: '0000',
        expMonth: 12,
        expYear: new Date().getUTCFullYear() + 1,
        status: 'active',
      },
    );
    await payment.start({
      ...startRequest,
      savedCardId: '00000000-0000-4000-8000-000000000004',
    });

    await expect(
      payment.start({
        ...startRequest,
        savedCardId: '00000000-0000-4000-8000-000000000005',
      }),
    ).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
  });
});

describe('PaymentDoubleService.refund', () => {
  const BOOKING = '00000000-0000-4000-8000-000000000010';
  const CHARGE = '00000000-0000-4000-8000-000000000011';
  const STARTED_ONLY = '00000000-0000-4000-8000-000000000012';
  const STARTED_CHARGE = '00000000-0000-4000-8000-000000000013';

  let charges: Charge[];
  let repository: {
    findByReference: Mock<PaymentChargeRepository['findByReference']>;
    refundSucceeded: Mock<PaymentChargeRepository['refundSucceeded']>;
  };
  let service: PaymentDoubleService;

  beforeEach(() => {
    charges = [
      {
        id: CHARGE,
        bookingReference: BOOKING,
        idempotencyKey: 'booking:test:charge',
        amountPiastres: 6955,
        currency: 'EGP',
        status: 'succeeded',
        stripePaymentMethodId: null,
      },
      {
        id: STARTED_CHARGE,
        bookingReference: STARTED_ONLY,
        idempotencyKey: 'booking:started-only:charge',
        amountPiastres: 6955,
        currency: 'EGP',
        status: 'started',
        stripePaymentMethodId: null,
      },
    ];
    repository = {
      findByReference: vi.fn<PaymentChargeRepository['findByReference']>(
        async (id, bookingReference) =>
          charges.find(
            (charge) =>
              charge.id === id && charge.bookingReference === bookingReference,
          ),
      ),
      refundSucceeded: vi.fn<PaymentChargeRepository['refundSucceeded']>(
        async (id) => {
          const charge = charges.find((c) => c.id === id);
          if (charge?.status !== 'succeeded') return false;
          charge.status = 'refunded';
          return true;
        },
      ),
    };
    service = new PaymentDoubleService(
      repository as unknown as PaymentChargeRepository,
      {} as ChargeCardRepository,
      {} as unknown as PaymentIntentService,
    );
  });

  const refundRequest = (overrides: { bookingReference?: string } = {}) => ({
    bookingReference: overrides.bookingReference ?? BOOKING,
    paymentReference:
      overrides.bookingReference === STARTED_ONLY ? STARTED_CHARGE : CHARGE,
    idempotencyKey: `booking:${overrides.bookingReference ?? BOOKING}:refund`,
  });

  it('refunds the whole locked total, booking fee included', async () => {
    const result = await service.refund({
      bookingReference: BOOKING,
      paymentReference: CHARGE,
      idempotencyKey: `booking:${BOOKING}:refund`,
    });
    expect(result.status).toBe('REFUNDED');
    expect(result.amountPiastres).toBe(6955);
    expect(charges.find((c) => c.id === CHARGE)?.status).toBe('refunded');
    expect(repository.findByReference).toHaveBeenCalledWith(CHARGE, BOOKING);
    expect(repository.refundSucceeded).toHaveBeenCalledWith(CHARGE);
  });

  it('is safe to call twice', async () => {
    await service.refund(refundRequest());
    expect((await service.refund(refundRequest())).status).toBe(
      'ALREADY_REFUNDED',
    );
    expect(repository.refundSucceeded).toHaveBeenCalledTimes(1);
  });

  it('refuses to refund a charge that never succeeded', async () => {
    await expect(
      service.refund(refundRequest({ bookingReference: STARTED_ONLY })),
    ).resolves.toEqual({
      status: 'NOT_REFUNDABLE',
      refundReference: '',
      amountPiastres: 0,
    });
    expect(repository.refundSucceeded).not.toHaveBeenCalled();
  });

  it('reports a concurrent winner as already refunded and returns the whole amount', async () => {
    const results = await Promise.all([
      service.refund(refundRequest()),
      service.refund(refundRequest()),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([
      'ALREADY_REFUNDED',
      'REFUNDED',
    ]);
    expect(results.every((result) => result.amountPiastres === 6955)).toBe(
      true,
    );
    expect(results[0].refundReference).toBe(results[1].refundReference);
  });
});
