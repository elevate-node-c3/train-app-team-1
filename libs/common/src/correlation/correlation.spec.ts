import { describe, expect, it } from 'vitest';
import {
  CorrelationMiddleware,
  CORRELATION_ID_HEADER,
  CORRELATION_ID_KEY,
  redactPii,
  maskEmail,
} from '@app/common';

describe('Correlation ID & PII Logging Redaction (§2.4)', () => {
  describe('CorrelationMiddleware', () => {
    it('always generates a fresh UUIDv4 at the gateway; client-sent values never replace it', () => {
      process.env.APP = 'gateway';

      let storedClsKey = '';
      let storedClsVal = '';
      const clsMock = {
        set: (k: string, v: string) => {
          storedClsKey = k;
          storedClsVal = v;
        },
      } as any;

      const middleware = new CorrelationMiddleware(clsMock);

      const clientSentId = 'client-injected-id-hack';
      let responseHeaderKey = '';
      let responseHeaderVal = '';

      const req: any = {
        headers: {
          [CORRELATION_ID_HEADER]: clientSentId,
        },
      };

      const res: any = {
        setHeader: (k: string, v: string) => {
          responseHeaderKey = k;
          responseHeaderVal = v;
        },
      };

      let nextCalled = false;
      middleware.use(req, res, () => {
        nextCalled = true;
      });

      expect(nextCalled).toBe(true);
      expect(responseHeaderKey).toBe(CORRELATION_ID_HEADER);
      expect(responseHeaderVal).not.toBe(clientSentId);
      // Valid UUIDv4 format
      expect(responseHeaderVal).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
      expect(storedClsKey).toBe(CORRELATION_ID_KEY);
      expect(storedClsVal).toBe(responseHeaderVal);
    });

    it('accepts and propagates upstream correlation ID in downstream services', () => {
      process.env.APP = 'identity';

      let storedClsVal = '';
      const clsMock = {
        set: (_k: string, v: string) => {
          storedClsVal = v;
        },
      } as any;

      const middleware = new CorrelationMiddleware(clsMock);
      const upstreamId = '550e8400-e29b-41d4-a716-446655440000';

      const req: any = {
        headers: {
          [CORRELATION_ID_HEADER]: upstreamId,
        },
      };

      let setHeaderVal = '';
      const res: any = {
        setHeader: (_k: string, v: string) => {
          setHeaderVal = v;
        },
      };

      middleware.use(req, res, () => {});

      expect(setHeaderVal).toBe(upstreamId);
      expect(storedClsVal).toBe(upstreamId);
    });
  });

  describe('PII Redactor & Email Masking', () => {
    it('masks emails into username initial + domain', () => {
      expect(maskEmail('youssef@example.com')).toBe('y***@example.com');
      expect(maskEmail('nour.dev@gmail.com')).toBe('n***@gmail.com');
    });

    it('redacts passwords, tokens, PINs, cards, and national IDs from objects', () => {
      const payload = {
        user: 'John Doe',
        email: 'john.doe@company.org',
        password: 'Password123!',
        token: 'eyJh...jwtToken',
        pin: '1234',
        cardNumber: '4111222233334444',
        cvv: '999',
        nationalId: '29801011234567',
        phone: '+201012345678',
        nested: {
          verificationCode: '654321',
          secret: 'api_secret_key',
          safeProperty: 'safe value',
        },
        items: [
          { token: 'secret-token', label: 'Item 1' },
          { email: 'contact@shop.com' },
        ],
      };

      const redacted = redactPii(payload);

      expect(redacted.password).toBe('[REDACTED]');
      expect(redacted.token).toBe('[REDACTED]');
      expect(redacted.pin).toBe('[REDACTED]');
      expect(redacted.cardNumber).toBe('[REDACTED]');
      expect(redacted.cvv).toBe('[REDACTED]');
      expect(redacted.nationalId).toBe('[REDACTED]');
      expect(redacted.phone).toBe('[REDACTED]');
      expect(redacted.nested.verificationCode).toBe('[REDACTED]');
      expect(redacted.nested.secret).toBe('[REDACTED]');
      expect(redacted.nested.safeProperty).toBe('safe value');
      expect(redacted.items[0].token).toBe('[REDACTED]');
      expect(redacted.items[0].label).toBe('Item 1');
      expect(redacted.email).toBe('j***@company.org');
      expect(redacted.items[1].email).toBe('c***@shop.com');
    });
  });
});
