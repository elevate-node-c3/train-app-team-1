import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DataSource } from 'typeorm';
import { PaymentDoubleService } from './payment-double.service.js';

describe('PaymentDoubleService', () => {
  let chargeStatus: 'started' | 'succeeded' | 'cancelled';
  let query: ReturnType<typeof vi.fn>;
  let payment: PaymentDoubleService;

  beforeEach(() => {
    vi.unstubAllEnvs();
    chargeStatus = 'started';
    query = vi.fn(async (sql: string) => {
      if (sql.includes('SELECT * FROM payment_charge')) {
        return [
          {
            id: '00000000-0000-4000-8000-000000000001',
            booking_reference: '00000000-0000-4000-8000-000000000002',
            idempotency_key: 'booking:test:charge',
            amount_piastres: 13_500,
            currency: 'EGP',
            status: chargeStatus,
          },
        ];
      }
      if (sql.includes("SET status = 'succeeded'")) {
        chargeStatus = 'succeeded';
        return [];
      }
      if (sql.includes("SET status = 'cancelled'")) {
        if (chargeStatus === 'started') {
          chargeStatus = 'cancelled';
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
  };

  it('returns the original charge for a repeated start key', async () => {
    const first = await payment.start(startRequest);
    const second = await payment.start(startRequest);

    expect(second).toEqual(first);
    expect(first.paymentReference).toBe(
      '00000000-0000-4000-8000-000000000001',
    );
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
});
