import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DataSource } from 'typeorm';
import { ErrorCode } from '@app/contracts';
import { StripeService } from './stripe.service.js';

describe('StripeService', () => {
  let service: StripeService;
  let mockDataSource: { query: ReturnType<typeof vi.fn> };

  const accountId = '11111111-1111-4111-8111-111111111111';

  beforeEach(() => {
    mockDataSource = {
      query: vi.fn(),
    };
    service = new StripeService(mockDataSource as unknown as DataSource);
  });

  it('returns existing stripe customer from database if present', async () => {
    mockDataSource.query.mockResolvedValueOnce([
      { stripe_customer_id: 'cus_existing_123' },
    ]);

    const customerId = await service.getOrCreateCustomer(accountId);
    expect(customerId).toBe('cus_existing_123');
    expect(mockDataSource.query).toHaveBeenCalledWith(
      'SELECT stripe_customer_id FROM payment_customer WHERE account_id = $1',
      [accountId],
    );
  });

  it('trips circuit breaker after 5 failures and fails fast with DEPENDENCY_UNAVAILABLE', async () => {
    // Mock stripe customer create to fail
    const stripeMock = (service as any).stripe;
    stripeMock.customers = {
      create: vi.fn().mockRejectedValue(new Error('Stripe API unreachable')),
    };

    mockDataSource.query.mockResolvedValue([]); // not in DB

    // Trigger 5 failures
    for (let i = 0; i < 5; i++) {
      await expect(service.getOrCreateCustomer(accountId)).rejects.toMatchObject({
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
});
