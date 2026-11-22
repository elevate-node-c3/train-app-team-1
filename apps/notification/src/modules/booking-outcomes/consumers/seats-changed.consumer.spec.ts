import { describe, expect, it, vi } from 'vitest';
import {
  BOOKING_SEATS_CHANGED_EVENT_TYPE,
  BOOKING_SEATS_CHANGED_VERSION,
  type EventEnvelope,
} from '@app/contracts';
import { SeatsChangedConsumer } from './seats-changed.consumer.js';

const BOOKING = 'booking-1';
const ACCOUNT = 'account-1';
const TRAVELLER_EMAIL = 'traveller@example.com';

function seatsChanged(overrides: Partial<EventEnvelope> = {}): EventEnvelope {
  return {
    id: 'evt_1',
    type: BOOKING_SEATS_CHANGED_EVENT_TYPE,
    version: BOOKING_SEATS_CHANGED_VERSION,
    occurredAt: '2026-11-22T10:00:00.000Z',
    correlationId: 'corr-1',
    producer: 'booking',
    payload: {
      bookingReference: BOOKING,
      accountId: ACCOUNT,
      seats: [
        {
          passengerRef: 'p1',
          tripId: 'trip-1',
          coachNumber: 7,
          seatNumber: '12',
        },
      ],
    },
    ...overrides,
  };
}

describe('SeatsChangedConsumer', () => {
  it('emails the traveller which seats they now have', async () => {
    const recipients = {
      emailFor: vi.fn().mockResolvedValue(TRAVELLER_EMAIL),
    };
    const sender = { send: vi.fn().mockResolvedValue(undefined) };
    const consumer = new SeatsChangedConsumer(
      recipients as never,
      sender as never,
    );

    const result = await consumer.handle(seatsChanged());

    expect(result).toEqual({ status: 'handled' });
    expect(recipients.emailFor).toHaveBeenCalledWith(ACCOUNT);
    expect(sender.send).toHaveBeenCalledWith(
      expect.objectContaining({ to: TRAVELLER_EMAIL }),
    );
  });

  it('keeps missing recipient data retryable rather than marking the event skipped', async () => {
    const recipients = {
      emailFor: vi
        .fn()
        .mockRejectedValue(new Error('Recipient not available yet')),
    };
    const sender = { send: vi.fn() };
    const consumer = new SeatsChangedConsumer(
      recipients as never,
      sender as never,
    );

    await expect(consumer.handle(seatsChanged())).rejects.toThrow(
      'Recipient not available yet',
    );
    expect(sender.send).not.toHaveBeenCalled();
  });

  it('propagates SMTP failure so a later delivery can retry the email', async () => {
    const recipients = {
      emailFor: vi.fn().mockResolvedValue(TRAVELLER_EMAIL),
    };
    const sender = {
      send: vi
        .fn()
        .mockRejectedValueOnce(new Error('SMTP unavailable'))
        .mockResolvedValue(undefined),
    };
    const consumer = new SeatsChangedConsumer(
      recipients as never,
      sender as never,
    );
    const envelope = seatsChanged({ id: 'evt_1' });
    await expect(consumer.handle(envelope)).rejects.toThrow('SMTP unavailable');
    await expect(consumer.handle(envelope)).resolves.toEqual({
      status: 'handled',
    });
    expect(sender.send).toHaveBeenCalledTimes(2);
  });
});
