import { describe, expect, it, vi } from 'vitest';
import type { EventEnvelope } from '@app/contracts';
import { BookingRefundedConsumer } from './booking-refunded.consumer.js';
import { SeatsChangedConsumer } from './seats-changed.consumer.js';
import { createBookingOutcomeSubscriptions } from '../booking-outcomes.module.js';

const EVENT: EventEnvelope = {
  id: '11111111-1111-4111-8111-111111111111',
  type: 'booking.refunded',
  version: 1,
  producer: 'booking',
  occurredAt: '2026-11-22T10:00:00.000Z',
  correlationId: 'correlation-1',
  payload: {
    bookingReference: 'booking-1',
    accountId: 'account-1',
    amountPiastres: 6955,
    reasonKey: 'REASON_NO_SEATS_AFTER_LATE_PAYMENT',
  },
};

describe('BookingRefundedConsumer', () => {
  it('preserves the recipient, full refund amount and accepted email content', async () => {
    const recipients = {
      emailFor: vi.fn().mockResolvedValue('traveller@example.com'),
    };
    const emails = { send: vi.fn().mockResolvedValue(undefined) };
    const consumer = new BookingRefundedConsumer(
      recipients as never,
      emails as never,
    );
    await expect(consumer.handle(EVENT)).resolves.toEqual({
      status: 'handled',
    });
    expect(recipients.emailFor).toHaveBeenCalledWith('account-1');
    expect(emails.send).toHaveBeenCalledWith({
      to: 'traveller@example.com',
      subject: 'Your booking was refunded in full',
      text: expect.stringContaining('69.55 EGP in full'),
      html: expect.stringContaining('69.55'),
    });
  });

  it('retries recipient recovery instead of permanently skipping the refund', async () => {
    const recipients = {
      emailFor: vi
        .fn()
        .mockRejectedValueOnce(new Error('recipient pending'))
        .mockResolvedValue('traveller@example.com'),
    };
    const emails = { send: vi.fn().mockResolvedValue(undefined) };
    const consumer = new BookingRefundedConsumer(
      recipients as never,
      emails as never,
    );
    await expect(consumer.handle(EVENT)).rejects.toThrow('recipient pending');
    expect(emails.send).not.toHaveBeenCalled();
    await expect(consumer.handle(EVENT)).resolves.toEqual({
      status: 'handled',
    });
    expect(emails.send).toHaveBeenCalledTimes(1);
  });

  it('keeps SMTP failure retryable', async () => {
    const recipients = {
      emailFor: vi.fn().mockResolvedValue('traveller@example.com'),
    };
    const emails = {
      send: vi.fn().mockRejectedValue(new Error('SMTP unavailable')),
    };
    const consumer = new BookingRefundedConsumer(
      recipients as never,
      emails as never,
    );
    await expect(consumer.handle(EVENT)).rejects.toThrow('SMTP unavailable');
  });

  it('keeps both outcome subscriptions retrying after an extended outage', () => {
    const subscriptions = createBookingOutcomeSubscriptions(
      {} as SeatsChangedConsumer,
      {} as BookingRefundedConsumer,
    );
    expect(subscriptions).toHaveLength(2);
    expect(
      subscriptions.every((subscription) => subscription.retryIndefinitely),
    ).toBe(true);
  });
});
