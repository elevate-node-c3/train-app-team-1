import { describe, expect, it } from 'vitest';
import { isEventEnvelope } from '@app/contracts';
import { buildPaymentSucceeded } from './payment-events.factory.js';

describe('buildPaymentSucceeded', () => {
  it('builds a payment.charge.succeeded envelope with payment as its producer', () => {
    const event = buildPaymentSucceeded({
      eventId: '11111111-1111-4111-8111-111111111111',
      correlationId: 'corr-1',
      occurredAt: new Date('2026-11-21T10:00:00.000Z'),
      payload: {
        bookingReference: '22222222-2222-4222-8222-222222222222',
        paymentReference: '33333333-3333-4333-8333-333333333333',
        amountPiastres: 6955,
        currency: 'EGP',
        stripeEventId: 'evt_1',
      },
    });

    expect(event.type).toBe('payment.charge.succeeded');
    expect(event.version).toBe(1);
    expect(event.producer).toBe('payment');
    expect(event.occurredAt).toBe('2026-11-21T10:00:00.000Z');
    expect(event.payload.amountPiastres).toBe(6955);
    expect(isEventEnvelope(event)).toBe(true);
  });
});
