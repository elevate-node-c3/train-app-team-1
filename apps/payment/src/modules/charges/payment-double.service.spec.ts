import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DataSource } from 'typeorm';
import { PaymentDoubleService } from './payment-double.service.js';

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
    payment = new PaymentDoubleService({
      query,
    } as unknown as DataSource);
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
    payment = new PaymentDoubleService({
      query,
    } as unknown as DataSource);
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
