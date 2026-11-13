import { EVENTS_EXCHANGE } from '@app/messaging/amqp-topology.js';
import type { EventHandlerPort } from '@app/messaging/consumer/event-handler.port.js';
import { describe, expect, it, vi } from 'vitest';

import { createTripLifecycleSubscriptions } from './trip-lifecycle.module.js';
import {
  INVENTORY_TRIP_LIFECYCLE_QUEUES,
  INVENTORY_TRIP_PUBLISHED_QUEUE,
  INVENTORY_TRIP_WITHDRAWN_QUEUE,
  TRIP_LIFECYCLE_EVENT_TYPES,
  TripLifecycleTopologyService,
} from './trip-lifecycle.topology.js';

interface Binding {
  queue: string;
  exchange: string;
  routingKey: string;
}

function makeService(options: { failChannel?: boolean } = {}) {
  const bindings: Binding[] = [];
  const queues: string[] = [];
  const consume = vi.fn();

  const channel = {
    assertExchange: vi.fn().mockResolvedValue({}),
    assertQueue: vi.fn(async (name: string) => {
      queues.push(name);
      return { queue: name, messageCount: 0, consumerCount: 0 };
    }),
    bindQueue: vi.fn(
      async (queue: string, exchange: string, routingKey: string) => {
        bindings.push({ queue, exchange, routingKey });
        return {};
      },
    ),
    consume,
  };

  // Matches AmqpReconnectListener: the real handler is async.
  const reconnectListeners: (() => void | Promise<void>)[] = [];
  const unsubscribe = vi.fn();

  const amqp = {
    ensureChannel: vi.fn(async () => {
      if (options.failChannel) {
        throw new Error('broker unreachable');
      }
      return channel;
    }),
    onReconnect: vi.fn((listener: () => void) => {
      reconnectListeners.push(listener);
      return unsubscribe;
    }),
  };

  const service = new TripLifecycleTopologyService(amqp as never);

  return {
    service,
    amqp,
    bindings,
    queues,
    consume,
    reconnectListeners,
    unsubscribe,
  };
}

describe('TripLifecycleTopologyService', () => {
  it('binds each trip event to its own queue on the shared exchange', async () => {
    const { service, bindings } = makeService();

    await service.onApplicationBootstrap();

    expect(bindings).toEqual(
      expect.arrayContaining([
        {
          queue: INVENTORY_TRIP_PUBLISHED_QUEUE,
          exchange: EVENTS_EXCHANGE,
          routingKey: 'catalog.trip.published',
        },
        {
          queue: INVENTORY_TRIP_WITHDRAWN_QUEUE,
          exchange: EVENTS_EXCHANGE,
          routingKey: 'catalog.trip.withdrawn',
        },
      ]),
    );
  });

  it('carries the routing keys catalog actually publishes', async () => {
    expect([...TRIP_LIFECYCLE_EVENT_TYPES]).toEqual([
      'catalog.trip.published',
      'catalog.trip.withdrawn',
    ]);
  });

  it('declares one queue per event type', async () => {
    const { service, queues } = makeService();

    await service.declare();

    const declaredQueues = queues.filter((name) =>
      (INVENTORY_TRIP_LIFECYCLE_QUEUES as readonly string[]).includes(name),
    );
    expect(declaredQueues).toEqual([
      'inventory.trip-lifecycle.trip-published',
      'inventory.trip-lifecycle.trip-withdrawn',
    ]);
  });

  it('never binds two event types to one queue', () => {
    const handler: EventHandlerPort = {
      handle: async () => ({ status: 'handled' }),
    };
    const queues = createTripLifecycleSubscriptions(handler).map(
      (s) => s.queueName,
    );

    expect(new Set(queues).size).toBe(queues.length);
  });

  it('declares the queue without consuming it', async () => {
    // Consuming now would acknowledge and discard the backlog.
    const { service, consume, queues } = makeService();

    await service.onApplicationBootstrap();

    expect(queues).toContain(INVENTORY_TRIP_PUBLISHED_QUEUE);
    expect(queues).toContain(INVENTORY_TRIP_WITHDRAWN_QUEUE);
    expect(consume).not.toHaveBeenCalled();
  });

  it('declares the retry and dead-letter queues the consumer needs', async () => {
    const { service, queues } = makeService();

    await service.onApplicationBootstrap();

    for (const queue of INVENTORY_TRIP_LIFECYCLE_QUEUES) {
      expect(queues).toContain(`${queue}.dlq`);
      expect(queues.some((name) => name.startsWith(`${queue}.retry.`))).toBe(
        true,
      );
    }
  });

  it('re-declares after the connection is replaced', async () => {
    // New brokers need the queue before more events are published.
    const { service, reconnectListeners, amqp } = makeService();

    await service.onApplicationBootstrap();
    expect(amqp.ensureChannel).toHaveBeenCalledTimes(1);

    await reconnectListeners[0]();
    expect(amqp.ensureChannel).toHaveBeenCalledTimes(2);
  });

  it('degrades instead of killing boot when the broker is unreachable', async () => {
    const { service } = makeService({ failChannel: true });

    await expect(service.onApplicationBootstrap()).resolves.toBeUndefined();
  });

  it('stops listening for reconnects on shutdown', async () => {
    const { service, unsubscribe } = makeService();

    await service.onApplicationBootstrap();
    service.beforeApplicationShutdown();

    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});
