import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Options } from 'amqplib';
import { EVENT_TYPES, type EventEnvelope } from '@app/contracts';
import {
  EVENTS_EXCHANGE,
  EventPublisherService,
  injectCorrelationId,
  OutboxRelayService,
  appendParams,
  rowFrom,
} from '@app/messaging';
import { SchemaReadinessGate } from '@app/common/persistence/schema-readiness.gate.js';

const EVENT: EventEnvelope = {
  id: '11111111-1111-4111-8111-111111111111',
  type: EVENT_TYPES.holdExpired,
  version: 1,
  occurredAt: '2026-11-15T10:00:00.000Z',
  correlationId: 'hold-correlation',
  producer: 'inventory',
  payload: { holdId: 'hold-1', state: 'expired' },
};
const SECOND_ID = '22222222-2222-4222-8222-222222222222';

class FakeChannel extends EventEmitter {
  writable = true;
  readonly pending: {
    exchange: string;
    routingKey: string;
    body: Buffer;
    options: Options.Publish;
    confirm: (error: Error | null) => void;
  }[] = [];
  assertExchange = vi.fn(async () => {});
  assertQueue = vi.fn(async () => {});
  bindQueue = vi.fn(async () => {});
  close = vi.fn(async () => {
    this.emit('close');
  });
  publish = vi.fn(
    (
      exchange: string,
      routingKey: string,
      body: Buffer,
      options: Options.Publish,
      confirm: (error: Error | null) => void,
    ) => {
      this.pending.push({ exchange, routingKey, body, options, confirm });
      return this.writable;
    },
  );

  confirm(index: number, error: Error | null = null): void {
    this.pending[index].confirm(error);
  }

  returnMessage(index: number): void {
    const pending = this.pending[index];
    this.emit('return', {
      fields: {
        replyCode: 312,
        replyText: 'NO_ROUTE',
        exchange: pending.exchange,
        routingKey: pending.routingKey,
      },
      properties: { messageId: pending.options.messageId },
      content: pending.body,
    });
  }
}

function harness(channel = new FakeChannel()) {
  let current = channel;
  const amqp = {
    ensureConfirmChannel: vi.fn(async () => current),
    invalidateConfirmChannel: vi.fn((stalled: FakeChannel) => {
      if (current === stalled) current = new FakeChannel();
      void stalled.close();
    }),
  };
  return {
    channel,
    amqp,
    current: () => current,
    publisher: new EventPublisherService(amqp as any),
  };
}

async function flush(): Promise<void> {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('EventPublisherService mandatory lifecycle publication', () => {
  it.each([
    EVENT_TYPES.holdHeld,
    EVENT_TYPES.holdReleased,
    EVENT_TYPES.holdExpired,
    EVENT_TYPES.holdExtended,
    EVENT_TYPES.paymentSucceeded,
    EVENT_TYPES.bookingConfirmed,
    EVENT_TYPES.bookingSeatsChanged,
    EVENT_TYPES.bookingRefunded,
  ])(
    'requires routing and confirms for %s without declaring consumer queues',
    async (type) => {
      const h = harness();
      const event = { ...EVENT, type };
      const publication = h.publisher.publishConfirmed(event);
      await flush();

      expect(h.channel.pending).toHaveLength(1);
      const pending = h.channel.pending[0];
      expect(pending.exchange).toBe(EVENTS_EXCHANGE);
      expect(pending.routingKey).toBe(type);
      expect(pending.options).toMatchObject({
        persistent: true,
        mandatory: true,
        messageId: EVENT.id,
        headers: injectCorrelationId(EVENT.correlationId),
      });
      expect(JSON.parse(pending.body.toString())).toEqual(event);
      expect(h.channel.assertQueue).not.toHaveBeenCalled();
      expect(h.channel.bindQueue).not.toHaveBeenCalled();

      h.channel.confirm(0);
      await publication;
      expect(h.channel.listenerCount('return')).toBe(0);
      expect(h.channel.listenerCount('close')).toBe(0);
      expect(h.channel.listenerCount('error')).toBe(0);
    },
  );

  it.each([
    EVENT_TYPES.verificationCodeIssued,
    EVENT_TYPES.seatAvailabilityChanged,
    'inventory.hold.unknown',
  ])('leaves existing non-mandatory routing unchanged for %s', async (type) => {
    const h = harness();
    const publication = h.publisher.publishConfirmed({ ...EVENT, type });
    await flush();

    expect(h.channel.pending[0].options).not.toHaveProperty('mandatory');
    expect(h.channel.listenerCount('return')).toBe(1);
    h.channel.returnMessage(0);
    h.channel.confirm(0);
    await publication;
  });

  it.each([
    EVENT_TYPES.holdExpired,
    EVENT_TYPES.paymentSucceeded,
    EVENT_TYPES.bookingConfirmed,
    EVENT_TYPES.bookingSeatsChanged,
    EVENT_TYPES.bookingRefunded,
  ])(
    'rejects unroutable %s even if the broker acknowledges it',
    async (type) => {
      const h = harness();
      const publication = h.publisher.publishConfirmed({ ...EVENT, type });
      const rejected = expect(publication).rejects.toThrow(
        'AMQP mandatory return 312 NO_ROUTE',
      );
      await flush();
      h.channel.returnMessage(0);
      h.channel.confirm(0);
      await rejected;
      expect(h.channel.listenerCount('return')).toBe(0);
    },
  );

  it('correlates concurrent returns by message ID rather than rejecting other events', async () => {
    const h = harness();
    const first = h.publisher.publishConfirmed(EVENT);
    const second = h.publisher.publishConfirmed({ ...EVENT, id: SECOND_ID });
    const results = Promise.allSettled([first, second]);
    await flush();

    h.channel.emit('return', {
      properties: { messageId: 'unrelated-event' },
      fields: { replyCode: 312, replyText: 'NO_ROUTE' },
    });
    h.channel.returnMessage(1);
    h.channel.confirm(1);
    h.channel.confirm(0);

    const outcomes = await results;
    expect(outcomes[0].status).toBe('fulfilled');
    expect(outcomes[1]).toMatchObject({
      status: 'rejected',
      reason: expect.objectContaining({
        message: expect.stringContaining(SECOND_ID),
      }),
    });
    expect(h.channel.assertExchange).toHaveBeenCalledTimes(1);
  });

  it.each([
    EVENT_TYPES.paymentSucceeded,
    EVENT_TYPES.bookingConfirmed,
    EVENT_TYPES.bookingSeatsChanged,
    EVENT_TYPES.bookingRefunded,
  ])('leaves unroutable %s pending for relay recovery', async (type) => {
    const h = harness();
    const event = { ...EVENT, type };
    const row = rowFrom(appendParams(event));
    let published = false;
    const outbox = {
      claimBatch: vi.fn(async () => (published ? [] : [row])),
      recordFailure: vi.fn(async () => {}),
      markPublishedBatch: vi.fn(async () => {
        published = true;
      }),
    };
    const relay = () =>
      new OutboxRelayService(
        {
          withTransaction: async (
            work: (ctx: { driver: string }) => Promise<unknown>,
          ) => work({ driver: 'fake' }),
        } as never,
        outbox as never,
        h.publisher,
        {
          run: async (work: () => Promise<unknown>) => work(),
          set: vi.fn(),
        } as never,
        new SchemaReadinessGate(),
      );
    const first = relay().runOnce();
    await flush();
    h.channel.returnMessage(0);
    h.channel.confirm(0);
    await expect(first).resolves.toBe(0);
    expect(outbox.recordFailure).toHaveBeenCalled();
    expect(outbox.markPublishedBatch).not.toHaveBeenCalled();

    // A later relay instance retries the same envelope after routing recovers.
    const retry = relay().runOnce();
    await flush();
    expect(h.channel.pending[1].options.messageId).toBe(event.id);
    expect(JSON.parse(h.channel.pending[1].body.toString())).toEqual(event);
    h.channel.confirm(1);
    await expect(retry).resolves.toBe(1);
    expect(outbox.markPublishedBatch).toHaveBeenCalledTimes(1);
  });

  it('multiplexes 64 pending confirms without adding a listener per message', async () => {
    const h = harness();
    const publications = Array.from({ length: 64 }, (_, index) =>
      h.publisher.publishConfirmed({
        ...EVENT,
        id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      }),
    );
    const done = Promise.allSettled(publications);
    await flush();
    expect(h.channel.pending).toHaveLength(64);
    expect(h.channel.listenerCount('return')).toBe(1);
    expect(h.channel.listenerCount('close')).toBe(1);
    expect(h.channel.listenerCount('error')).toBe(1);
    h.channel.returnMessage(31);
    for (let index = 63; index >= 0; index -= 1) h.channel.confirm(index);
    const results = await done;
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(63);
    expect(results[31]).toMatchObject({ status: 'rejected' });
    expect(h.channel.listenerCount('return')).toBe(0);
    expect(h.channel.listenerCount('close')).toBe(0);
    expect(h.channel.listenerCount('error')).toBe(0);
  });

  it('rejects every in-flight attempt on channel loss and preserves internal listeners', async () => {
    const h = harness();
    const internalClose = vi.fn();
    h.channel.on('close', internalClose);
    const done = Promise.allSettled(
      [EVENT, { ...EVENT, id: SECOND_ID }].map((event) =>
        h.publisher.publishConfirmed(event),
      ),
    );
    await flush();
    h.channel.emit('close');
    expect((await done).every((result) => result.status === 'rejected')).toBe(
      true,
    );
    expect(h.channel.listeners('close')).toEqual([internalClose]);
    expect(h.channel.listenerCount('return')).toBe(0);
  });

  it.each(['nack', 'close', 'error'])(
    'rejects on %s before confirmation',
    async (failure) => {
      const h = harness();
      const internalClose = vi.fn();
      h.channel.on('close', internalClose);
      const publication = h.publisher.publishConfirmed(EVENT);
      const rejected = expect(publication).rejects.toThrow();
      await flush();

      if (failure === 'nack') h.channel.confirm(0, new Error('message nacked'));
      else if (failure === 'close') h.channel.emit('close');
      else h.channel.emit('error', new Error('broker disconnected'));

      await rejected;
      expect(h.channel.listeners('close')).toEqual([internalClose]);
      expect(h.channel.listenerCount('return')).toBe(0);
      expect(h.channel.listenerCount('error')).toBe(0);
    },
  );

  it('rejects a synchronous publish failure and removes only its own listeners', async () => {
    const h = harness();
    const internalClose = vi.fn();
    h.channel.on('close', internalClose);
    h.channel.publish.mockImplementationOnce(() => {
      throw new Error('channel already closed');
    });
    await expect(h.publisher.publishConfirmed(EVENT)).rejects.toThrow(
      'channel already closed',
    );
    expect(h.channel.listeners('close')).toEqual([internalClose]);
    expect(h.channel.listenerCount('return')).toBe(0);
  });

  it('retries a failed exchange declaration on the same channel', async () => {
    const h = harness();
    h.channel.assertExchange.mockRejectedValueOnce(
      new Error('declaration failed'),
    );
    await expect(h.publisher.publishConfirmed(EVENT)).rejects.toThrow(
      'declaration failed',
    );
    expect(h.channel.publish).not.toHaveBeenCalled();

    const retry = h.publisher.publishConfirmed(EVENT);
    await flush();
    expect(h.channel.assertExchange).toHaveBeenCalledTimes(2);
    h.channel.confirm(0);
    await retry;
  });
});

describe('EventPublisherService deadlines and backpressure', () => {
  it('times out a stalled confirmation and retries on a new channel with the same event ID', async () => {
    vi.useFakeTimers();
    vi.stubEnv('AMQP_PUBLISH_CONFIRM_TIMEOUT_MS', '25');
    const h = harness();
    const internalClose = vi.fn();
    h.channel.on('close', internalClose);
    const publication = h.publisher.publishConfirmed(EVENT);
    const rejected = expect(publication).rejects.toThrow(
      'timed out after 25ms',
    );
    await vi.advanceTimersByTimeAsync(25);
    await rejected;

    expect(h.amqp.invalidateConfirmChannel).toHaveBeenCalledExactlyOnceWith(
      h.channel,
    );
    expect(internalClose).toHaveBeenCalledTimes(1);
    expect(h.channel.listeners('close')).toEqual([internalClose]);
    expect(h.channel.listenerCount('return')).toBe(0);
    h.channel.confirm(0); // A late acknowledgement cannot turn the failed attempt into success.

    const retry = h.publisher.publishConfirmed(EVENT);
    await flush();
    const replacement = h.current();
    expect(replacement).not.toBe(h.channel);
    expect(replacement.pending[0].options.messageId).toBe(EVENT.id);
    expect(JSON.parse(replacement.pending[0].body.toString())).toEqual(EVENT);
    replacement.confirm(0);
    await retry;
  });

  it('prevents a channel acquired after the deadline from publishing late', async () => {
    vi.useFakeTimers();
    vi.stubEnv('AMQP_PUBLISH_CONFIRM_TIMEOUT_MS', '25');
    const h = harness();
    let release: (channel: FakeChannel) => void = () => {};
    h.amqp.ensureConfirmChannel.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const publication = h.publisher.publishConfirmed(EVENT);
    const rejected = expect(publication).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(25);
    await rejected;
    release(h.channel);
    await flush();

    expect(h.channel.publish).not.toHaveBeenCalled();
    expect(h.channel.assertExchange).not.toHaveBeenCalled();
    expect(h.amqp.invalidateConfirmChannel).not.toHaveBeenCalled();
  });

  it('bounds a stalled topology declaration and never publishes afterward', async () => {
    vi.useFakeTimers();
    vi.stubEnv('AMQP_PUBLISH_CONFIRM_TIMEOUT_MS', '25');
    const h = harness();
    let release: () => void = () => {};
    h.channel.assertExchange.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const publication = h.publisher.publishConfirmed(EVENT);
    const rejected = expect(publication).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(25);
    await rejected;
    release();
    await flush();

    expect(h.channel.publish).not.toHaveBeenCalled();
    expect(h.amqp.invalidateConfirmChannel).toHaveBeenCalledExactlyOnceWith(
      h.channel,
    );
  });

  it('waits for drain even after confirmation and pauses other channel publishers', async () => {
    const h = harness();
    h.channel.writable = false;
    let firstFinished = false;
    const first = h.publisher.publishConfirmed(EVENT).then(() => {
      firstFinished = true;
    });
    const second = h.publisher.publishConfirmed({ ...EVENT, id: SECOND_ID });
    const done = Promise.all([first, second]);
    await flush();
    expect(h.channel.publish).toHaveBeenCalledTimes(1);
    h.channel.confirm(0);
    await flush();
    expect(firstFinished).toBe(false);
    expect(h.channel.publish).toHaveBeenCalledTimes(1);

    h.channel.writable = true;
    h.channel.emit('drain');
    await flush();
    expect(firstFinished).toBe(true);
    expect(h.channel.publish).toHaveBeenCalledTimes(2);
    h.channel.confirm(1);
    await done;
    expect(h.channel.listenerCount('drain')).toBe(0);
  });

  it('rechecks backpressure when multiple publishers resume from the same drain', async () => {
    const h = harness();
    h.channel.writable = false;
    const done = Promise.all([
      h.publisher.publishConfirmed(EVENT),
      h.publisher.publishConfirmed({ ...EVENT, id: SECOND_ID }),
      h.publisher.publishConfirmed({
        ...EVENT,
        id: '33333333-3333-4333-8333-333333333333',
      }),
    ]);
    await flush();
    expect(h.channel.publish).toHaveBeenCalledTimes(1);
    h.channel.confirm(0);
    h.channel.emit('drain');
    await flush();
    expect(h.channel.publish).toHaveBeenCalledTimes(2);

    h.channel.confirm(1);
    h.channel.writable = true;
    h.channel.emit('drain');
    await flush();
    expect(h.channel.publish).toHaveBeenCalledTimes(3);
    h.channel.confirm(2);
    await done;
  });

  it('times out a stalled drain even if a confirmation arrived', async () => {
    vi.useFakeTimers();
    vi.stubEnv('AMQP_PUBLISH_CONFIRM_TIMEOUT_MS', '25');
    const h = harness();
    h.channel.writable = false;
    const publication = h.publisher.publishConfirmed(EVENT);
    const rejected = expect(publication).rejects.toThrow('timed out');
    await flush();
    h.channel.confirm(0);
    await vi.advanceTimersByTimeAsync(25);
    await rejected;

    expect(h.amqp.invalidateConfirmChannel).toHaveBeenCalledExactlyOnceWith(
      h.channel,
    );
    expect(h.channel.listenerCount('drain')).toBe(0);
    expect(h.channel.listenerCount('error')).toBe(0);
  });

  it.each([
    ['0', 5_000],
    ['2.5', 5_000],
    ['999999', 60_000],
  ] as const)(
    'keeps timeout configuration %s bounded at %sms',
    async (configured, deadline) => {
      vi.useFakeTimers();
      vi.stubEnv('AMQP_PUBLISH_CONFIRM_TIMEOUT_MS', configured);
      const h = harness();
      const publication = h.publisher.publishConfirmed(EVENT);
      const rejected = expect(publication).rejects.toThrow(
        `timed out after ${deadline}ms`,
      );
      await vi.advanceTimersByTimeAsync(deadline - 1);
      expect(h.amqp.invalidateConfirmChannel).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await rejected;
    },
  );
});
