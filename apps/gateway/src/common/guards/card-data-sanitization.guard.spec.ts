import { describe, expect, it } from 'vitest';
import {
  HttpException,
  HttpStatus,
  type ExecutionContext,
} from '@nestjs/common';
import { ErrorCode } from '@app/contracts';
import { CardDataSanitizationGuard } from './card-data-sanitization.guard.js';

describe('CardDataSanitizationGuard', () => {
  const guard = new CardDataSanitizationGuard();

  function mockContext(body: unknown, query: unknown = {}): ExecutionContext {
    return {
      switchToHttp: () => ({
        getRequest: () => ({ body, query }),
      }),
    } as unknown as ExecutionContext;
  }

  it('allows safe payloads without card details', () => {
    const ctx = mockContext({ setupIntentId: 'seti_123', holderName: 'Ahmed' });
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('rejects payload containing cardNumber without echoing the value', () => {
    const sensitiveNumber = '4242424242424242';
    const ctx = mockContext({ cardNumber: sensitiveNumber });

    try {
      guard.canActivate(ctx);
      expect.fail('Expected guard to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(HttpException);
      const httpErr = err as HttpException;
      expect(httpErr.getStatus()).toBe(HttpStatus.BAD_REQUEST);
      const response = httpErr.getResponse() as Record<string, unknown>;
      expect(response.code).toBe(ErrorCode.INVALID_PAYLOAD);
      expect(JSON.stringify(response)).not.toContain(sensitiveNumber);
    }
  });

  it('rejects payload containing cvv in body or query without echoing value', () => {
    const sensitiveCvv = '123';
    const ctxBody = mockContext({ cvv: sensitiveCvv });

    expect(() => guard.canActivate(ctxBody)).toThrow(HttpException);

    const ctxQuery = mockContext({}, { cvv: sensitiveCvv });
    expect(() => guard.canActivate(ctxQuery)).toThrow(HttpException);
  });

  it('rejects payload containing pan or expiration fields', () => {
    expect(() => guard.canActivate(mockContext({ pan: '1234' }))).toThrow();
    expect(() => guard.canActivate(mockContext({ exp_month: 12 }))).toThrow();
    expect(() => guard.canActivate(mockContext({ expiry: '12/28' }))).toThrow();
  });

  it('rejects card-data aliases and Stripe secrets without echoing their values', () => {
    const secret = 'seti_123_secret_client_secret';
    const cases = [
      { expiryMonth: 12 },
      { security_code: '123' },
      { card_number: 4242424242424242 },
      { clientSecret: secret },
      { setupIntentId: secret },
      { setupIntentId: '4242424242424242' },
    ];

    for (const body of cases) {
      try {
        guard.canActivate(mockContext(body));
        expect.fail('Expected sensitive payload to be rejected');
      } catch (error) {
        expect(error).toBeInstanceOf(HttpException);
        expect(
          JSON.stringify((error as HttpException).getResponse()),
        ).not.toContain(secret);
        expect(
          JSON.stringify((error as HttpException).getResponse()).includes(
            '4242424242424242',
          ),
        ).toBe(false);
      }
    }
  });

  it('rejects Stripe client secrets used as query, path, or header values', () => {
    const secret = 'seti_123_secret_client_secret';
    for (const request of [
      { body: {}, query: { setupIntentId: secret } },
      { body: {}, query: {}, params: { setupIntentId: secret } },
      {
        body: {},
        query: {},
        params: {},
        headers: { 'x-client-secret': secret },
      },
    ]) {
      expect(() =>
        guard.canActivate({
          switchToHttp: () => ({ getRequest: () => request }),
        } as unknown as ExecutionContext),
      ).toThrow(HttpException);
    }
  });
});
