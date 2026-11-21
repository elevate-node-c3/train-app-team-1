import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DataSource } from 'typeorm';
import { ErrorCode } from '@app/contracts';
import { PaymentIntentService } from './payment-intent.service.js';
import { PaymentDoubleService, type ChargeRow } from './payment-double.service.js';

describe('PaymentDoubleService', () => {
  let chargeStatus: 'started' | 'succeeded' | 'cancelled';
  let query: ReturnType<typeof vi.fn>;
  let payment: PaymentDoubleService;
  let savedCards: Array<{
    id: string;
    account_id: string;
    stripe_payment_method_id: string;
    brand: string;
    last4: string;
    exp_month: number;
    exp_year: number;
    status: 'active' | 'detached';
  }>;
  let savedCharge: Record<string, unknown> | undefined;

  beforeEach(() => {
    vi.unstubAllEnvs();
    chargeStatus = 'started';
    savedCards = [];
    savedCharge = undefined;
    query = vi.fn(async (sql: string, params: unknown[] = []) => {
      if (sql.includes('FROM saved_card')) {
        return savedCards.filter(
          (card) => card.id === params[0] && card.account_id === params[1],
        );
      }
      if (sql.includes('INSERT INTO payment_charge')) {
        if (!savedCharge) {
          savedCharge = {
            id: '00000000-0000-4000-8000-000000000001',
            booking_reference: params[1],
            idempotency_key: params[2],
            amount_piastres: params[3],
            currency: params[4],
            status: 'started',
            card_brand: params[5],
            card_last4: params[6],
            stripe_payment_method_id: params[7],
          };
        }
        return [];
      }
      if (sql.includes('SELECT * FROM payment_charge')) {
        return savedCharge ? [{ ...savedCharge, status: chargeStatus }] : [];
      }
      if (sql.includes("SET status = 'succeeded'")) {
        chargeStatus = 'succeeded';
        if (savedCharge) savedCharge.status = 'succeeded';
        return [];
      }
      if (sql.includes("SET status = 'cancelled'")) {
        if (chargeStatus === 'started') {
          chargeStatus = 'cancelled';
          if (savedCharge) savedCharge.status = 'cancelled';
          return [{ status: chargeStatus }];
        }
        return [];
      }
      if (sql.includes('SELECT status FROM payment_charge')) {
        return [{ status: chargeStatus }];
      }
      return [];
    });
    payment = new PaymentDoubleService(
      { query } as unknown as DataSource,
      {
        startFor: vi.fn().mockResolvedValue({
          paymentIntentId: 'pi_new',
          clientSecret: 'pi_new_secret',
          status: 'requires_payment_method',
        }),
      } as unknown as PaymentIntentService,
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
    expect(query).toHaveBeenCalledTimes(4);
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
  });

  it('reports an already-succeeded charge rather than cancelling it', async () => {
    vi.stubEnv(
      'PAYMENT_DOUBLE_SUCCEEDED_BOOKINGS',
      startRequest.bookingReference,
    );
    payment = new PaymentDoubleService(
      { query } as unknown as DataSource,
      {
        startFor: vi.fn().mockResolvedValue({
          paymentIntentId: 'pi_new',
          clientSecret: 'pi_new_secret',
          status: 'requires_payment_method',
        }),
      } as unknown as PaymentIntentService,
    );
    const charge = await payment.start(startRequest);

    expect(
      await payment.cancel({
        bookingReference: startRequest.bookingReference,
        paymentReference: charge.paymentReference,
        idempotencyKey: 'booking:test:cancel',
      }),
    ).toEqual({ status: 'ALREADY_SUCCEEDED' });
  });

  it('charges only an owned, active saved card and snapshots its payment details', async () => {
    savedCards.push({
      id: '00000000-0000-4000-8000-000000000004',
      account_id: startRequest.accountId,
      stripe_payment_method_id: 'pm_owned',
      brand: 'visa',
      last4: '4242',
      exp_month: 12,
      exp_year: new Date().getUTCFullYear() + 1,
      status: 'active',
    });

    await payment.start({
      ...startRequest,
      savedCardId: '00000000-0000-4000-8000-000000000004',
    });

    expect(savedCharge).toMatchObject({
      card_brand: 'visa',
      card_last4: '4242',
      stripe_payment_method_id: 'pm_owned',
    });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('FROM saved_card'),
      ['00000000-0000-4000-8000-000000000004', startRequest.accountId],
    );
  });

  it('returns not found for a card owned by another traveller', async () => {
    savedCards.push({
      id: '00000000-0000-4000-8000-000000000004',
      account_id: '00000000-0000-4000-8000-000000000005',
      stripe_payment_method_id: 'pm_foreign',
      brand: 'visa',
      last4: '4242',
      exp_month: 12,
      exp_year: new Date().getUTCFullYear() + 1,
      status: 'active',
    });

    await expect(
      payment.start({
        ...startRequest,
        savedCardId: '00000000-0000-4000-8000-000000000004',
      }),
    ).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    expect(savedCharge).toBeUndefined();
  });

  it('refuses an expired saved card', async () => {
    savedCards.push({
      id: '00000000-0000-4000-8000-000000000004',
      account_id: startRequest.accountId,
      stripe_payment_method_id: 'pm_expired',
      brand: 'visa',
      last4: '4242',
      exp_month: 1,
      exp_year: new Date().getUTCFullYear() - 1,
      status: 'active',
    });

    await expect(
      payment.start({
        ...startRequest,
        savedCardId: '00000000-0000-4000-8000-000000000004',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_PAYLOAD' });
    expect(savedCharge).toBeUndefined();
  });

  it('replays a started payment after its saved card has been deleted', async () => {
    savedCards.push({
      id: '00000000-0000-4000-8000-000000000004',
      account_id: startRequest.accountId,
      stripe_payment_method_id: 'pm_owned',
      brand: 'visa',
      last4: '4242',
      exp_month: 12,
      exp_year: new Date().getUTCFullYear() + 1,
      status: 'active',
    });
    const request = {
      ...startRequest,
      savedCardId: '00000000-0000-4000-8000-000000000004',
    };
    const first = await payment.start(request);
    savedCards[0].status = 'detached';

    await expect(payment.start(request)).resolves.toEqual(first);
  });

  it('still returns 404 for a foreign card when the booking already has a charge', async () => {
    savedCards.push(
      {
        id: '00000000-0000-4000-8000-000000000004',
        account_id: startRequest.accountId,
        stripe_payment_method_id: 'pm_owned',
        brand: 'visa',
        last4: '4242',
        exp_month: 12,
        exp_year: new Date().getUTCFullYear() + 1,
        status: 'active',
      },
      {
        id: '00000000-0000-4000-8000-000000000005',
        account_id: '00000000-0000-4000-8000-000000000006',
        stripe_payment_method_id: 'pm_foreign',
        brand: 'visa',
        last4: '0000',
        exp_month: 12,
        exp_year: new Date().getUTCFullYear() + 1,
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

  let charges: ChargeRow[];
  let query: ReturnType<typeof vi.fn>;
  let service: PaymentDoubleService;

  beforeEach(() => {
    charges = [
      {
        id: CHARGE,
        booking_reference: BOOKING,
        idempotency_key: 'booking:test:charge',
        amount_piastres: 6955,
        currency: 'EGP',
        status: 'succeeded',
        stripe_payment_method_id: null,
      },
      {
        id: STARTED_CHARGE,
        booking_reference: STARTED_ONLY,
        idempotency_key: 'booking:started-only:charge',
        amount_piastres: 6955,
        currency: 'EGP',
        status: 'started',
        stripe_payment_method_id: null,
      },
    ];
    query = vi.fn(async (sql: string, params: unknown[] = []) => {
      if (sql.includes('SELECT * FROM payment_charge WHERE id')) {
        return charges.filter(
          (charge) =>
            charge.id === params[0] && charge.booking_reference === params[1],
        );
      }
      if (sql.includes("SET status = 'refunded'")) {
        const charge = charges.find((c) => c.id === params[0]);
        if (charge && charge.status === 'succeeded') charge.status = 'refunded' as ChargeRow['status'];
        return [];
      }
      return [];
    });
    service = new PaymentDoubleService(
      { query } as unknown as DataSource,
      {} as unknown as PaymentIntentService,
    );
  });

  const refundRequest = (overrides: { bookingReference?: string } = {}) => ({
    bookingReference: overrides.bookingReference ?? BOOKING,
    paymentReference: overrides.bookingReference === STARTED_ONLY ? STARTED_CHARGE : CHARGE,
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
  });

  it('is safe to call twice', async () => {
    await service.refund(refundRequest());
    expect((await service.refund(refundRequest())).status).toBe('ALREADY_REFUNDED');
  });

  it('refuses to refund a charge that never succeeded', async () => {
    await expect(
      service.refund(refundRequest({ bookingReference: STARTED_ONLY })),
    ).rejects.toMatchObject({ code: ErrorCode.CONFLICT });
  });
});
