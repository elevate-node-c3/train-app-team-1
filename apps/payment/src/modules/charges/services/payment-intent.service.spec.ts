import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { StripeService } from '../../cards/services/stripe.service.js';
import { PaymentIntentService } from './payment-intent.service.js';
import type { ChargeRow } from '../payment-double.service.js';

const BOOKING = '22222222-2222-4222-8222-222222222222';

function chargeRow(overrides: Partial<ChargeRow> = {}): ChargeRow {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    booking_reference: BOOKING,
    idempotency_key: `booking:${BOOKING}:charge`,
    amount_piastres: 6955,
    currency: 'EGP',
    status: 'started',
    stripe_payment_method_id: null,
    ...overrides,
  };
}

describe('PaymentIntentService', () => {
  let dataSource: { query: ReturnType<typeof vi.fn> };
  let stripe: StripeService;
  let service: PaymentIntentService;
  let logs: string[];
  let client: {
    paymentIntents: {
      create: ReturnType<typeof vi.fn>;
      retrieve: ReturnType<typeof vi.fn>;
    };
  };

  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_validForPaymentIntentServiceTests');
    logs = [];
    vi.spyOn(Logger.prototype, 'log').mockImplementation(
      function (this: Logger, message?: string) {
        logs.push(String(message ?? ''));
      },
    );
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    dataSource = { query: vi.fn().mockResolvedValue([]) };
    stripe = new StripeService({
      query: vi.fn(),
      transaction: vi.fn(),
    } as unknown as DataSource);
    const stripeMock = (stripe as unknown as { stripeClient: unknown }).stripeClient as {
      paymentIntents: {
        create: ReturnType<typeof vi.fn>;
        retrieve: ReturnType<typeof vi.fn>;
      };
    };
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
    service = new PaymentIntentService(stripe, dataSource as unknown as DataSource);
  });

  it('creates the intent with the booking-derived idempotency key and the locked amount', async () => {
    const result = await service.startFor(chargeRow());

    expect(client.create).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 6955, currency: 'egp' }),
      expect.objectContaining({ idempotencyKey: `booking:${BOOKING}:charge` }),
    );
    expect(result.paymentIntentId).toBe('pi_new');
    expect(result.clientSecret).toBe('pi_new_secret');
  });

  it('retrieves the existing intent instead of creating a second one', async () => {
    const result = await service.startFor(
      chargeRow({ stripe_payment_intent_id: 'pi_existing' }),
    );

    expect(client.retrieve).toHaveBeenCalledWith('pi_existing');
    expect(client.create).not.toHaveBeenCalled();
    expect(result.paymentIntentId).toBe('pi_existing');
  });

  it('never puts the client secret in a log line', async () => {
    await service.startFor(chargeRow());

    expect(logs.join('\n')).not.toContain('secret');
  });
});
