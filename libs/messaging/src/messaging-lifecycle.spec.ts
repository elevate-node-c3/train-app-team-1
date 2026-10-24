import { describe, expect, it, vi } from 'vitest';
import type { ConsumeMessage } from 'amqplib';
import { CORRELATION_ID_HEADER as COMMON_CORRELATION_ID_HEADER } from '@app/common';
import {
  AmqpClientService,
  CORRELATION_ID_HEADER,
  EventConsumerService,
  EventFailureRouter,
  EventPublisherService,
  MessageRepublisher,
  extractCorrelationId,
  injectCorrelationId,
  type EventSubscription,
} from '@app/messaging';
import { GracefulShutdownService } from '@app/common';
import type { EventEnvelope } from '@app/contracts';

/**
 * These assertions pin Nest's shutdown contract as it actually behaves:
 * `onModuleDestroy` -> `beforeApplicationShutdown` -> dispose -> 
 * `onApplicationShutdown`. The repo's docs claimed the opposite, and following
 * them would close the channel before consumers could ack.
 */
describe('Messaging lifecycle (ADR-0003, ADR-0004)', () => {
  it('keeps one correlation header constant across both libraries', () => {
    expect(CORRELATION_ID_HEADER).toBe(COMMON_CORRELATION_ID_HEADER);
  });

  it('injects and extracts a string correlation id', () => {
    const headers = injectCorrelationId('abc', { other: 'kept' });
    expect(headers).toEqual({
      other: 'kept',
      [CORRELATION_ID_HEADER]: 'abc',
    });
    expect(extractCorrelationId(headers)).toBe('abc');
  });

  it('extracts a correlation id stored as a Buffer', () => {
    expect(
      extractCorrelationId({ [CORRELATION_ID_HEADER]: Buffer.from('abc') }),
    ).toBe('abc');
  });

  it('does not promise an onModuleDestroy hook on the AMQP client', () => {
    const client = new AmqpClientService();
    // Re-adding one would close the channel in step 1, before the relay and
    // consumer drain in step 2. This assertion is the guard against that.
    expect('onModuleDestroy' in client).toBe(false);
    expect(typeof client.onApplicationShutdown).toBe('function');
  });

  it('closes the channels only at onApplicationShutdown, after acks', async () => {
    const calls: string[] = [];
    const client = new AmqpClientService() as any;
    // amqplib channels and connections are EventEmitters, and the client
    // detaches its handlers before closing so a teardown cannot re-enter them.
    // The fakes carry `removeAllListeners` for that reason.
    client.confirmChannel = {
      removeAllListeners: () => {},
      close: async () => {
        calls.push('confirm-close');
      },
    };
    client.channel = {
      removeAllListeners: () => {},
      close: async () => {
        calls.push('channel-close');
      },
    };
    client.connection = {
      removeAllListeners: () => {},
      close: async () => {
        calls.push('connection-close');
      },
    };

    // A drain participant's ack is recorded first; the client must not close
    // before it. This mirrors Nest's real hook order (step 2 then step 4).
    calls.push('ack');
    await client.onApplicationShutdown();

    expect(calls).toEqual([
      'ack',
      'confirm-close',
      'channel-close',
      'connection-close',
    ]);
  });

  it('stops accepting requests in onModuleDestroy, not onApplicationShutdown', () => {
    const shutdown = new GracefulShutdownService();
    expect(shutdown.isAcceptingRequests()).toBe(true);

    shutdown.onModuleDestroy();

    expect(shutdown.isAcceptingRequests()).toBe(false);
    expect('onApplicationShutdown' in shutdown).toBe(false);
  });

  // The order Nest actually calls: onModuleDestroy -> beforeApplicationShutdown
  // -> dispose -> onApplicationShutdown. The ack must be on the channel before
  // it closes; otherwise the broker redelivers every in-flight message and a
  // clean deploy sends duplicate emails.
  it('acks an in-flight message before the channel closes, in Nest hook order', async () => {
    const events: string[] = [];
    let releaseHandler: () => void = () => {};
    const handlerGate = new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });

    const envelope: EventEnvelope = {
      id: '11111111-1111-4111-8111-111111111111',
      type: 'identity.verification-code.issued',
      version: 1,
      occurredAt: '2026-10-24T10:00:00.000Z',
      correlationId: 'corr-1',
      producer: 'identity',
      payload: {},
    };

    let consumeCallback: ((message: ConsumeMessage) => void) | undefined;
    const plainChannel = {
      ack: vi.fn(() => events.push('ack')),
      nack: vi.fn(),
      cancel: vi.fn(async () => {
        events.push('cancel');
      }),
      prefetch: vi.fn(async () => {}),
      consume: vi.fn(
        async (
          _queue: string,
          callback: (message: ConsumeMessage) => void,
        ) => {
          consumeCallback = callback;
          return { consumerTag: 'tag-1' };
        },
      ),
      assertExchange: vi.fn(async () => {}),
      assertQueue: vi.fn(async () => {}),
      bindQueue: vi.fn(async () => {}),
    };
    const confirmChannel = {
      publish: vi.fn(
        (_exchange: string, _routingKey: string, _body: Buffer, _opts: unknown, cb: any) => {
          cb(null);
          return true;
        },
      ),
    };
    const amqp = {
      ensureChannel: async () => plainChannel,
      ensureConfirmChannel: async () => confirmChannel,
      onReconnect: () => () => {},
      registerLivenessProbe: () => () => {},
      onApplicationShutdown: async () => {
        events.push('channel-close');
      },
    };

    const subscription: EventSubscription = {
      eventType: envelope.type,
      version: 1,
      queueName: 'notification.verification-code-issued',
      handler: {
        handle: async () => {
          await handlerGate;
          return { status: 'handled' };
        },
      },
      retryDelaysMs: [1000],
    };

    const store = {
      claim: async () => 1,
      markHandled: async () => {},
      markSkipped: async () => {},
      markFailed: async () => {},
    } as any;
    const consumer = new EventConsumerService(
      [subscription],
      amqp as any,
      store,
      { run: async (fn: () => Promise<unknown>) => fn(), set: vi.fn() } as any,
      new EventFailureRouter(new MessageRepublisher(amqp as any), store),
    );

    await consumer.onApplicationBootstrap();
    expect(consumeCallback).toBeDefined();

    const shutdown = new GracefulShutdownService();
    shutdown.onModuleDestroy(); // step 1

    consumeCallback!({
      content: Buffer.from(JSON.stringify(envelope)),
      fields: { redelivered: false },
      properties: { headers: {} },
    } as unknown as ConsumeMessage);

    // Let claim and handler entry happen, then start the drain while the
    // handler is still in flight.
    await Promise.resolve();
    await Promise.resolve();
    const drain = consumer.beforeApplicationShutdown(); // step 2
    releaseHandler();
    await drain;

    events.push('dispose'); // step 3
    await amqp.onApplicationShutdown(); // step 4

    expect(events).toEqual(['cancel', 'ack', 'dispose', 'channel-close']);
    expect(events.indexOf('ack')).toBeLessThan(
      events.indexOf('channel-close'),
    );
  });
});

/**
 * `channel.consume` dies with its channel. Subscribing once at bootstrap left
 * notification connected and deaf after any broker restart, while the readiness
 * probe still answered `ready` because the connection itself was fine.
 */
describe('Consumer re-attachment after a broker restart', () => {
  const QUEUE = 'notification.verification-code-issued';
  const EVENT_TYPE = 'identity.verification-code.issued';

  function consumerHarness(options: { consumeFails?: boolean } = {}) {
    let reconnect: (() => void | Promise<void>) | undefined;
    let liveness: (() => { healthy: boolean; detail?: string }) | undefined;
    const consumedOn: unknown[] = [];

    const channel = {
      prefetch: vi.fn(async () => {}),
      cancel: vi.fn(async () => {}),
      assertExchange: vi.fn(async () => {}),
      assertQueue: vi.fn(async () => {}),
      bindQueue: vi.fn(async () => {}),
      consume: vi.fn(async () => {
        if (options.consumeFails) {
          throw new Error('CHANNEL_ERROR - expected channel.open');
        }
        consumedOn.push(channel);
        return { consumerTag: `tag-${consumedOn.length}` };
      }),
    };

    const amqp = {
      ensureChannel: async () => channel,
      ensureConfirmChannel: async () => ({ publish: vi.fn() }),
      onReconnect: (listener: () => void | Promise<void>) => {
        reconnect = listener;
        return () => {
          reconnect = undefined;
        };
      },
      registerLivenessProbe: (
        probe: () => { healthy: boolean; detail?: string },
      ) => {
        liveness = probe;
        return () => {
          liveness = undefined;
        };
      },
    } as any;

    const subscription: EventSubscription = {
      eventType: EVENT_TYPE,
      version: 1,
      queueName: QUEUE,
      handler: { handle: async () => ({ status: 'handled' as const }) },
      retryDelaysMs: [1000],
    };

    const store = {
      claim: async () => 1,
      markHandled: async () => {},
      markSkipped: async () => {},
      markFailed: async () => {},
    } as any;
    const consumer = new EventConsumerService(
      [subscription],
      amqp,
      store,
      { run: async (fn: () => Promise<unknown>) => fn(), set: vi.fn() } as any,
      new EventFailureRouter(new MessageRepublisher(amqp), store),
    );

    return {
      consumer,
      channel,
      consumedOn,
      fireReconnect: () => reconnect?.(),
      probe: () => liveness?.(),
    };
  }

  it('re-subscribes when the connection is replaced', async () => {
    const h = consumerHarness();
    await h.consumer.onApplicationBootstrap();
    expect(h.consumedOn).toHaveLength(1);

    await h.fireReconnect();

    expect(h.consumedOn).toHaveLength(2);
    expect(h.probe()).toEqual({ healthy: true });
  });

  it('reports the silent queue when re-subscribing fails', async () => {
    const h = consumerHarness({ consumeFails: true });
    await h.consumer.onApplicationBootstrap();

    // The broker is reachable, so only the consumer knows it is not reading.
    expect(h.probe()).toEqual({
      healthy: false,
      detail: `Not consuming: ${QUEUE}`,
    });
  });

  it('stops re-attaching once draining, so a shutdown close is not an outage', async () => {
    const h = consumerHarness();
    await h.consumer.onApplicationBootstrap();

    await h.consumer.beforeApplicationShutdown();
    await h.fireReconnect();

    expect(h.consumedOn).toHaveLength(1);
  });

  it('acks on the channel the message arrived on', async () => {
    const h = consumerHarness();
    const ack = vi.fn();
    const deliveringChannel = { ack, nack: vi.fn() } as any;

    const envelope: EventEnvelope = {
      id: '22222222-2222-4222-8222-222222222222',
      type: EVENT_TYPE,
      version: 1,
      occurredAt: '2026-10-24T10:00:00.000Z',
      correlationId: 'corr-2',
      producer: 'identity',
      payload: {},
    };

    await h.consumer.handleMessage(
      {
        eventType: EVENT_TYPE,
        version: 1,
        queueName: QUEUE,
        handler: { handle: async () => ({ status: 'handled' as const }) },
        retryDelaysMs: [1000],
      },
      {
        content: Buffer.from(JSON.stringify(envelope)),
        fields: { redelivered: false },
        properties: { headers: {} },
      } as unknown as ConsumeMessage,
      deliveringChannel,
    );

    // A delivery tag is scoped to its channel: acking on whatever
    // `ensureChannel()` returns addresses nothing after a reconnect.
    expect(ack).toHaveBeenCalledTimes(1);
  });
});

/**
 * The producer's exchange assertion was latched to a boolean, so a rebuilt
 * broker meant `train.events` was never re-asserted and every relay publish
 * failed 404 in a permanent loop.
 */
describe('Producer topology re-assertion', () => {
  it('re-asserts the exchange on a replacement channel', async () => {
    const envelope: EventEnvelope = {
      id: '33333333-3333-4333-8333-333333333333',
      type: 'identity.verification-code.issued',
      version: 1,
      occurredAt: '2026-10-24T10:00:00.000Z',
      correlationId: 'corr-3',
      producer: 'identity',
      payload: {},
    };

    const newChannel = () => ({
      assertExchange: vi.fn(async () => {}),
      assertQueue: vi.fn(async () => {}),
      bindQueue: vi.fn(async () => {}),
      publish: vi.fn(
        (
          _exchange: string,
          _key: string,
          _body: Buffer,
          _opts: unknown,
          cb: (error: unknown) => void,
        ) => {
          cb(null);
          return true;
        },
      ),
    });

    const first = newChannel();
    const second = newChannel();
    let current = first;
    const publisher = new EventPublisherService({
      ensureConfirmChannel: async () => current,
    } as any);

    await publisher.publishConfirmed(envelope);
    await publisher.publishConfirmed(envelope);
    expect(first.assertExchange).toHaveBeenCalledTimes(1);

    // The broker was rebuilt: same service, new channel, no exchange.
    current = second;
    await publisher.publishConfirmed(envelope);

    expect(second.assertExchange).toHaveBeenCalledTimes(1);
  });
});
