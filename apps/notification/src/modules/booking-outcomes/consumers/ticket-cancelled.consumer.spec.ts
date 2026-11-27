import { describe, expect, it, vi } from 'vitest';
import type { EventEnvelope } from '@app/contracts';
import {
  TICKET_CANCELLED_EVENT_TYPE,
  TICKET_CANCELLED_VERSION,
  type TicketCancelledPayloadV1,
} from '@app/contracts';
import { TicketCancelledConsumer } from './ticket-cancelled.consumer.js';

const PAYLOAD: TicketCancelledPayloadV1 = {
  ticketId: 'ticket-1',
  bookingReference: 'booking-1',
  passengerRef: 'passenger-1',
  tripId: 'trip-1',
  coachNumber: 3,
  seatNumber: '12',
  accountId: 'account-1',
  refundPiastres: 7750,
  paymentReference: 'charge-1',
};

function event(overrides: Partial<EventEnvelope> = {}): EventEnvelope {
  return {
    id: 'evt_1',
    type: TICKET_CANCELLED_EVENT_TYPE,
    version: TICKET_CANCELLED_VERSION,
    occurredAt: '2026-11-22T10:00:00.000Z',
    correlationId: 'corr-1',
    producer: 'booking',
    payload: PAYLOAD,
    ...overrides,
  };
}

describe('TicketCancelledConsumer', () => {
  it('sends one cancellation email to the account in the account language', async () => {
    const recipients = {
      recipientFor: vi
        .fn()
        .mockResolvedValue({ email: 'traveller@example.com', language: 'en' }),
    };
    const sender = { send: vi.fn().mockResolvedValue(undefined) };
    const consumer = new TicketCancelledConsumer(
      recipients as never,
      sender as never,
    );

    const result = await consumer.handle(event());

    expect(result).toEqual({ status: 'handled' });
    expect(recipients.recipientFor).toHaveBeenCalledWith('account-1');
    expect(sender.send).toHaveBeenCalledTimes(1);
    const email = sender.send.mock.calls[0][0];
    expect(email.to).toBe('traveller@example.com');
    expect(email.subject).toBe('Your ticket for booking booking-1 was cancelled');
    expect(email.text).toContain('77.50 EGP');
    expect(email.text).toContain('booking-1');
    expect(email.html).toContain('dir="ltr"');
    // regression: refund amount stays bold in English
    expect(email.html).toContain('<strong>77.50 EGP</strong>');
  });

  it('renders the email in Arabic for an Arabic account', async () => {
    const recipients = {
      recipientFor: vi
        .fn()
        .mockResolvedValue({ email: 'traveller@example.com', language: 'ar' }),
    };
    const sender = { send: vi.fn().mockResolvedValue(undefined) };
    const consumer = new TicketCancelledConsumer(
      recipients as never,
      sender as never,
    );

    await consumer.handle(event());

    const email = sender.send.mock.calls[0][0];
    expect(email.to).toBe('traveller@example.com');
    expect(sender.send).toHaveBeenCalledTimes(1);
    expect(email.subject).toBe('تأكيد إلغاء التذكرة');
    expect(email.text).toContain('تم إلغاء تذكرتك بنجاح. تجد أدناه تفاصيل التذكرة ومبلغ الاسترداد المطلوب.');
    expect(email.text).toContain('رقم العربة: 3، رقم المقعد: 12');
    expect(email.text).toContain('مبلغ الاسترداد المطلوب: 77.50 جنيه مصري');
    expect(email.html).toContain('dir="rtl"');
    expect(email.html).toContain('lang="ar"');
    // regression: refund amount stays bold in Arabic
    expect(email.html).toContain('<strong>77.50 جنيه مصري</strong>');
    // old placeholder wording must be absent
    expect(email.subject).not.toContain('هذه التذكرة ملغاة بالفعل');
    expect(email.text).not.toContain('هذه التذكرة ملغاة بالفعل');
  });

  it('keeps recipient recovery retryable', async () => {
    const recipients = {
      recipientFor: vi
        .fn()
        .mockRejectedValueOnce(new Error('recipient pending'))
        .mockResolvedValue({ email: 'traveller@example.com', language: 'en' }),
    };
    const sender = { send: vi.fn().mockResolvedValue(undefined) };
    const consumer = new TicketCancelledConsumer(
      recipients as never,
      sender as never,
    );

    await expect(consumer.handle(event())).rejects.toThrow('recipient pending');
    expect(sender.send).not.toHaveBeenCalled();
    await expect(consumer.handle(event())).resolves.toEqual({
      status: 'handled',
    });
    expect(sender.send).toHaveBeenCalledTimes(1);
  });

  it('propagates SMTP failure so a later delivery can retry', async () => {
    const recipients = {
      recipientFor: vi
        .fn()
        .mockResolvedValue({ email: 'traveller@example.com', language: 'en' }),
    };
    const sender = {
      send: vi
        .fn()
        .mockRejectedValueOnce(new Error('SMTP unavailable'))
        .mockResolvedValue(undefined),
    };
    const consumer = new TicketCancelledConsumer(
      recipients as never,
      sender as never,
    );

    await expect(consumer.handle(event())).rejects.toThrow('SMTP unavailable');
    await expect(consumer.handle(event())).resolves.toEqual({
      status: 'handled',
    });
    expect(sender.send).toHaveBeenCalledTimes(2);
  });

  it('dead-letters a malformed event', async () => {
    const recipients = {
      recipientFor: vi.fn().mockResolvedValue({
        email: 'traveller@example.com',
        language: 'en',
      }),
    };
    const sender = { send: vi.fn() };
    const consumer = new TicketCancelledConsumer(
      recipients as never,
      sender as never,
    );

    await expect(
      consumer.handle(event({ payload: { ...PAYLOAD, refundPiastres: -1 } as any })),
    ).rejects.toThrow();
    expect(sender.send).not.toHaveBeenCalled();
  });
});
