import { describe, expect, it, vi } from 'vitest';
import {
  BOOKING_SEATS_CHANGED_EVENT_TYPE,
  BOOKING_SEATS_CHANGED_VERSION,
  type EventEnvelope,
} from '@app/contracts';
import type { ProcessedEventStorePort } from '@app/messaging/consumer/processed-event.port.js';
import { SeatsChangedConsumer } from './seats-changed.consumer.js';

const BOOKING = 'booking-1';
const ACCOUNT = 'account-1';
const TRAVELLER_EMAIL = 'traveller@example.com';

function seatsChanged(
  overrides: Partial<EventEnvelope> = {},
): EventEnvelope {
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
      seats: [{ passengerRef: 'p1', tripId: 'trip-1', coachNumber: 7, seatNumber: '12' }],
    },
    ...overrides,
  };
}

/** Mirrors EventConsumerService's claim-then-handle sequence, without AMQP. */
class InMemoryProcessedEventStore implements ProcessedEventStorePort {
  private readonly claimed = new Set<string>();

  async claim(event: { eventId: string }): Promise<number | null> {
    if (this.claimed.has(event.eventId)) return null;
    this.claimed.add(event.eventId);
    return 1;
  }

  async markHandled(): Promise<void> {}
  async markSkipped(): Promise<void> {}
  async markFailed(): Promise<void> {}
}

describe('SeatsChangedConsumer', () => {
  it('emails the traveller which seats they now have', async () => {
    const travellers = {
      findByAccountId: vi.fn().mockResolvedValue({ email: TRAVELLER_EMAIL }),
    };
    const sender = { send: vi.fn().mockResolvedValue(undefined) };
    const consumer = new SeatsChangedConsumer(
      travellers as never,
      sender as never,
    );

    const result = await consumer.handle(seatsChanged());

    expect(result).toEqual({ status: 'handled' });
    expect(sender.send).toHaveBeenCalledWith(
      expect.objectContaining({ to: TRAVELLER_EMAIL }),
    );
  });

  it('skips when no address is on file, rather than failing the event', async () => {
    const travellers = { findByAccountId: vi.fn().mockResolvedValue(null) };
    const sender = { send: vi.fn() };
    const consumer = new SeatsChangedConsumer(
      travellers as never,
      sender as never,
    );

    const result = await consumer.handle(seatsChanged());

    expect(result).toEqual({ status: 'skipped', skipReason: 'no_email_on_file' });
    expect(sender.send).not.toHaveBeenCalled();
  });

  it('handles the same event twice without sending twice', async () => {
    const travellers = {
      findByAccountId: vi.fn().mockResolvedValue({ email: TRAVELLER_EMAIL }),
    };
    const sender = { send: vi.fn().mockResolvedValue(undefined) };
    const consumer = new SeatsChangedConsumer(
      travellers as never,
      sender as never,
    );
    const store = new InMemoryProcessedEventStore();
    const envelope = seatsChanged({ id: 'evt_1' });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const claimed = await store.claim({
        eventId: envelope.id,
        eventType: envelope.type,
        redelivered: attempt > 0,
        leaseSeconds: 60,
      });
      if (claimed !== null) await consumer.handle(envelope);
    }

    expect(sender.send).toHaveBeenCalledTimes(1);
  });
});
