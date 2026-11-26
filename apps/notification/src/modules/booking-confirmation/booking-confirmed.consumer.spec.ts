import type { Channel, ConsumeMessage } from 'amqplib';
import { describe, expect, it, vi } from 'vitest';
import type {
  BookingConfirmedPayloadV1,
  BookingConfirmedTicketV1,
  EventEnvelope,
} from '@app/contracts';
import {
  EventConsumerService,
  EventFailureRouter,
  MessageRepublisher,
  RETRY_EXCHANGE,
} from '@app/messaging';
import { PermanentEventError } from '@app/messaging/event-errors.js';

import type { OutboundEmail } from '../verification-emails/email-sender.js';
import { createBookingConfirmationSubscriptions } from './booking-confirmation.module.js';
import { BookingConfirmedConsumer } from './booking-confirmed.consumer.js';
import { qrContentId } from './booking-confirmed.template.js';

const at = (iso: string) => ({
  localDate: iso.slice(0, 10),
  localTime: iso.slice(11, 16),
  utcOffset: '+02:00',
  iso,
  timeZone: 'Africa/Cairo',
});

function ticket(n: number, passengerName: string): BookingConfirmedTicketV1 {
  return {
    ticketNumber: `TKT-${n}`,
    ticketId: `00000000-0000-4000-8000-00000000000${n}`,
    passengerRef: `p${n}`,
    tripId: 'trip-1',
    passengerName,
    trainNumber: 916,
    travelClass: { en: 'Second Class AC', ar: 'الدرجة الثانية مكيفة' },
    boarding: {
      stationId: 's1',
      name: { en: 'El Raml Station', ar: 'محطة الرمل' },
      at: at('2099-01-10T12:30:00+02:00'),
    },
    alighting: {
      stationId: 's2',
      name: { en: 'Ramsis Station', ar: 'محطة رمسيس' },
      at: at('2099-01-10T16:00:00+02:00'),
    },
    coachNumber: 3,
    seatNumber: `1${n}`,
    durationMinutes: 210,
    farePiastres: 15500,
    qr: `eyJhbGciOiJFZERTQSJ9.payload-${n}.signature-${n}`,
  };
}

const PAYLOAD: BookingConfirmedPayloadV1 = {
  bookingReference: '11111111-1111-4111-8111-111111111111',
  accountId: 'account-1',
  bookingCode: 'K7MQ2X',
  totalPiastres: 33170,
  tickets: [ticket(1, 'Omar Khaled Hassan'), ticket(2, 'Mona Ahmed')],
};

const EVENT: EventEnvelope = {
  id: '33333333-3333-4333-8333-333333333333',
  type: 'booking.confirmed',
  version: 1,
  producer: 'booking',
  occurredAt: '2099-01-01T10:00:00.000Z',
  correlationId: 'correlation-1',
  payload: PAYLOAD,
};

function consumerFor(language: 'en' | 'ar') {
  const sent: OutboundEmail[] = [];
  const recipients = {
    recipientFor: vi
      .fn()
      .mockResolvedValue({ email: 'traveller@example.com', language }),
  };
  const emails = {
    send: vi.fn(async (email: OutboundEmail) => {
      sent.push(email);
    }),
  };
  const consumer = new BookingConfirmedConsumer(
    recipients as never,
    emails as never,
  );
  return { consumer, recipients, emails, sent };
}

describe('BookingConfirmedConsumer (BR-53)', () => {
  it('sends one email to the account, carrying every ticket and its QR', async () => {
    const { consumer, recipients, sent } = consumerFor('en');

    await expect(consumer.handle(EVENT)).resolves.toEqual({
      status: 'handled',
    });

    expect(recipients.recipientFor).toHaveBeenCalledWith('account-1');
    expect(sent).toHaveLength(1);
    const [email] = sent;
    expect(email.to).toBe('traveller@example.com');
    expect(email.subject).toBe('Your tickets for booking K7MQ2X');
    expect(email.attachments).toHaveLength(2);
    for (const { ticketNumber, passengerName } of PAYLOAD.tickets) {
      const image = email.attachments!.find(
        (attachment) => attachment.cid === qrContentId(ticketNumber),
      );
      expect(image?.contentType).toBe('image/png');
      // A real PNG, drawn from booking's signed payload.
      expect(image?.content.subarray(1, 4).toString()).toBe('PNG');
      expect(email.html).toContain(`cid:${qrContentId(ticketNumber)}`);
      expect(email.text).toContain(ticketNumber);
      expect(email.text).toContain(passengerName);
    }
    expect(email.text).toContain('Second Class AC');
    expect(email.text).toContain('El Raml Station · 10 Jan, 2099 · 12:30 PM');
    expect(email.text).toContain('Total paid: 331.70 EGP');
    expect(email.html).toContain('dir="ltr"');
  });

  it("writes in the account's language, right to left for Arabic", async () => {
    const { consumer, sent } = consumerFor('ar');

    await consumer.handle(EVENT);

    const [email] = sent;
    expect(email.subject).toBe('تذاكرك للحجز K7MQ2X');
    expect(email.html).toContain('dir="rtl"');
    expect(email.text).toContain('محطة الرمل · 10 يناير 2099 · 12:30 م');
    expect(email.text).toContain('الدرجة الثانية مكيفة');
    expect(email.text).toContain('إجمالي المدفوع: 331.70 ج.م');
  });

  it('dead-letters a malformed event instead of retrying it forever', async () => {
    const { consumer, emails } = consumerFor('en');

    await expect(
      consumer.handle({ ...EVENT, payload: { ...PAYLOAD, tickets: [] } }),
    ).rejects.toThrow(PermanentEventError);
    await expect(
      consumer.handle({
        ...EVENT,
        payload: { ...PAYLOAD, tickets: [{ ...ticket(1, 'X'), qr: '' }] },
      }),
    ).rejects.toThrow(PermanentEventError);
    expect(emails.send).not.toHaveBeenCalled();
  });
});

/**
 * The real consumer runtime over a fake channel, with a processed-event store
 * that behaves like the persistent table: a handled event is never claimed
 * again, a failed one is.
 */
function runtime(send: (email: OutboundEmail) => Promise<void>) {
  const state = new Map<string, { attempts: number; handled: boolean }>();
  const store = {
    claim: vi.fn(async ({ eventId }: { eventId: string }) => {
      const row = state.get(eventId) ?? { attempts: 0, handled: false };
      if (row.handled) return null;
      row.attempts += 1;
      state.set(eventId, row);
      return row.attempts;
    }),
    markHandled: vi.fn(async (eventId: string) => {
      state.get(eventId)!.handled = true;
    }),
    markSkipped: vi.fn(),
    markFailed: vi.fn(async () => {}),
  };
  const published: string[] = [];
  const confirmChannel = {
    publish: vi.fn(
      (
        exchange: string,
        _key: string,
        _body: Buffer,
        _o: unknown,
        cb: (e: null) => void,
      ) => {
        published.push(exchange);
        cb(null);
        return true;
      },
    ),
    waitForConfirms: vi.fn(async () => {}),
  };
  const amqp = {
    ensureChannel: async () => ({}),
    ensureConfirmChannel: async () => confirmChannel,
    onReconnect: () => () => {},
    registerLivenessProbe: () => () => {},
  } as never;
  const recipients = {
    recipientFor: vi
      .fn()
      .mockResolvedValue({ email: 'traveller@example.com', language: 'en' }),
  };
  const handler = new BookingConfirmedConsumer(
    recipients as never,
    { send } as never,
  );
  const [subscription] = createBookingConfirmationSubscriptions(handler);
  const consumer = new EventConsumerService(
    [subscription],
    amqp,
    store as never,
    { run: async (fn: () => Promise<unknown>) => fn(), set: vi.fn() } as never,
    new EventFailureRouter(new MessageRepublisher(amqp), store as never),
  );
  const channel = { ack: vi.fn(), nack: vi.fn() };
  const deliver = (redelivered = false) =>
    consumer.handleMessage(
      subscription,
      {
        content: Buffer.from(JSON.stringify(EVENT)),
        fields: { redelivered },
        properties: { headers: {}, messageId: EVENT.id },
      } as unknown as ConsumeMessage,
      channel as unknown as Channel,
    );
  return { deliver, channel, published, subscription };
}

describe('booking.confirmed delivery (BR-54)', () => {
  it('sends exactly one email when the same event arrives twice', async () => {
    const send = vi.fn(async () => {});
    const { deliver, channel } = runtime(send);

    await deliver();
    await deliver(true);

    expect(send).toHaveBeenCalledTimes(1);
    expect(channel.ack).toHaveBeenCalledTimes(2);
  });

  it('keeps the event while mail is down, and sends it once on recovery', async () => {
    const send = vi
      .fn<(email: OutboundEmail) => Promise<void>>()
      .mockRejectedValueOnce(new Error('ECONNREFUSED mailpit:1025'))
      .mockResolvedValue(undefined);
    const { deliver, published, subscription } = runtime(send);

    await deliver();
    // Not lost: handed to the retry exchange to come back later.
    expect(published).toEqual([RETRY_EXCHANGE]);
    expect(subscription.retryIndefinitely).toBe(true);

    await deliver();
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.results[1].type).toBe('return');

    await deliver(true);
    expect(send).toHaveBeenCalledTimes(2);
  });
});
