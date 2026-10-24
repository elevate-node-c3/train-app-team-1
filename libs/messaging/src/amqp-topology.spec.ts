import { describe, expect, it } from 'vitest';
import {
  BR03_BUDGET_MS,
  DEAD_LETTER_EXCHANGE,
  EVENTS_EXCHANGE,
  EVENT_HANDLER_TIMEOUT_MS,
  EVENT_RETRY_DELAYS_MS,
  OUTBOX_POLL_INTERVAL_MS,
  REQUEUE_EXCHANGE,
  RETRY_EXCHANGE,
  assertDeliveryBudget,
  consumerTopology,
  declareTopology,
  maxDeliveryAttempts,
  producerTopology,
  worstCaseDeliveryMs,
} from '@app/messaging';

type Call = Record<string, unknown>;

function fakeChannel(): {
  calls: Call[];
  channel: {
    assertExchange: (
      name: string,
      type: string,
      options: unknown,
    ) => Promise<unknown>;
    assertQueue: (name: string, options: unknown) => Promise<unknown>;
    bindQueue: (
      queue: string,
      exchange: string,
      key: string,
    ) => Promise<unknown>;
  };
} {
  const calls: Call[] = [];
  return {
    calls,
    channel: {
      assertExchange: async (name, type, options) => {
        calls.push({ kind: 'exchange', name, type, options });
        return {};
      },
      assertQueue: async (name, options) => {
        calls.push({ kind: 'queue', name, options });
        return { queue: name, messageCount: 0, consumerCount: 0 };
      },
      bindQueue: async (queue, exchange, routingKey) => {
        calls.push({ kind: 'binding', queue, exchange, routingKey });
        return {};
      },
    },
  };
}

const QUEUE = 'notification.verification-code-issued';
const EVENT = 'identity.verification-code.issued';

describe('AMQP topology and BR-03 budget (ADR-0004, BR-03)', () => {
  it('gives the producer only the durable topic exchange', async () => {
    const { calls, channel } = fakeChannel();
    await declareTopology(channel, producerTopology());

    expect(calls).toEqual([
      {
        kind: 'exchange',
        name: EVENTS_EXCHANGE,
        type: 'topic',
        options: { durable: true, autoDelete: false },
      },
    ]);
  });

  it('declares the consumer topology exactly as reviewed', async () => {
    const { calls, channel } = fakeChannel();
    await declareTopology(
      channel,
      consumerTopology({
        queue: QUEUE,
        eventType: EVENT,
        retryDelaysMs: [1000, 3000, 9000],
      }),
    );

    expect(calls).toEqual([
      // Re-asserted by the consumer so it can bind even when it starts before
      // the producer. Identical parameters keep the two declarations
      // compatible (AMQP rejects an exchange redefined with other options).
      {
        kind: 'exchange',
        name: EVENTS_EXCHANGE,
        type: 'topic',
        options: { durable: true, autoDelete: false },
      },
      {
        kind: 'exchange',
        name: RETRY_EXCHANGE,
        type: 'direct',
        options: { durable: true, autoDelete: false },
      },
      {
        kind: 'exchange',
        name: REQUEUE_EXCHANGE,
        type: 'direct',
        options: { durable: true, autoDelete: false },
      },
      {
        kind: 'exchange',
        name: DEAD_LETTER_EXCHANGE,
        type: 'direct',
        options: { durable: true, autoDelete: false },
      },
      {
        kind: 'queue',
        name: QUEUE,
        options: { durable: true, autoDelete: false },
      },
      {
        kind: 'binding',
        queue: QUEUE,
        exchange: EVENTS_EXCHANGE,
        routingKey: EVENT,
      },
      {
        kind: 'binding',
        queue: QUEUE,
        exchange: REQUEUE_EXCHANGE,
        routingKey: QUEUE,
      },
      ...[1000, 3000, 9000].flatMap((delay) => [
        {
          kind: 'queue',
          name: `${QUEUE}.retry.${delay}`,
          options: {
            durable: true,
            autoDelete: false,
            arguments: {
              'x-message-ttl': delay,
              'x-dead-letter-exchange': REQUEUE_EXCHANGE,
              'x-dead-letter-routing-key': QUEUE,
            },
          },
        },
        {
          kind: 'binding',
          queue: `${QUEUE}.retry.${delay}`,
          exchange: RETRY_EXCHANGE,
          routingKey: `${QUEUE}.retry.${delay}`,
        },
      ]),
      {
        kind: 'queue',
        name: `${QUEUE}.dlq`,
        options: { durable: true, autoDelete: false },
      },
      {
        kind: 'binding',
        queue: `${QUEUE}.dlq`,
        exchange: DEAD_LETTER_EXCHANGE,
        routingKey: QUEUE,
      },
    ]);
  });

  // The bug this prevents: Compose starts notification and identity together,
  // and a consumer that binds before the producer has declared `train.events`
  // gets a 404, logs once, and never subscribes. The consumer re-asserts the
  // exchange; the parameters must stay identical or AMQP rejects the second
  // declaration.
  it("re-asserts the producer's events exchange so startup order cannot break binding", () => {
    const producer = producerTopology().exchanges.find(
      (exchange) => exchange.name === EVENTS_EXCHANGE,
    );
    const consumer = consumerTopology({
      queue: QUEUE,
      eventType: EVENT,
      retryDelaysMs: [1000],
    }).exchanges.find((exchange) => exchange.name === EVENTS_EXCHANGE);

    expect(consumer).toEqual(producer);
  });

  it('has no dead-letter exchange on the main queue', () => {
    const topology = consumerTopology({
      queue: QUEUE,
      eventType: EVENT,
      retryDelaysMs: [1000],
    });
    const main = topology.queues.find((queue) => queue.name === QUEUE);
    expect(main?.arguments).toBeUndefined();
  });

  it('computes the BR-03 worst case as exactly 25 500ms', () => {
    // Exact, not `<`: raising a delay and loosening the assertion to `<` is how
    // a budget quietly erodes.
    expect(
      worstCaseDeliveryMs({
        pollIntervalMs: OUTBOX_POLL_INTERVAL_MS,
        handlerTimeoutMs: EVENT_HANDLER_TIMEOUT_MS,
        retryDelaysMs: EVENT_RETRY_DELAYS_MS,
      }),
    ).toBe(25_500);
  });

  it('allows one more attempt than there are retry delays', () => {
    expect(maxDeliveryAttempts([1000, 3000, 9000])).toBe(4);
  });

  it('rejects a configuration that leaves no BR-03 headroom', () => {
    expect(() =>
      assertDeliveryBudget({
        pollIntervalMs: 500,
        handlerTimeoutMs: 3000,
        retryDelaysMs: [10_000, 10_000, 10_000],
      }),
    ).toThrowError(/BR-03/);
  });

  it('accepts the reviewed configuration', () => {
    expect(() =>
      assertDeliveryBudget({
        pollIntervalMs: OUTBOX_POLL_INTERVAL_MS,
        handlerTimeoutMs: EVENT_HANDLER_TIMEOUT_MS,
        retryDelaysMs: EVENT_RETRY_DELAYS_MS,
      }),
    ).not.toThrow();
    expect(BR03_BUDGET_MS).toBe(30_000);
  });
});
