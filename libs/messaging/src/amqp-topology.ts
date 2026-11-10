import type { Channel } from 'amqplib';

/**
 * The AMQP topology as data, so it can be reviewed rather than discovered in a
 * console. Ownership is load-bearing: the producer declares `train.events` and
 * nothing else, a consumer declares its own exchanges and queues. Consumers
 * re-assert `train.events` identically, so startup order does not matter --
 * binding to a missing exchange 404s and subscribes them to nothing.
 */
export const EVENTS_EXCHANGE = 'train.events';
export const RETRY_EXCHANGE = 'train.events.retry';
export const REQUEUE_EXCHANGE = 'train.events.requeue';
export const DEAD_LETTER_EXCHANGE = 'train.events.dlx';

export type ExchangeType = 'topic' | 'direct';

export interface ExchangeDeclaration {
  name: string;
  type: ExchangeType;
  durable: boolean;
  autoDelete: boolean;
}

export interface QueueBindingDeclaration {
  exchange: string;
  routingKey: string;
}

export interface QueueDeclaration {
  name: string;
  durable: boolean;
  autoDelete: boolean;
  /** AMQP `x-*` arguments, omitted rather than `{}` when there are none. */
  arguments?: Record<string, unknown>;
  bindings: QueueBindingDeclaration[];
}

export interface TopologyDeclaration {
  exchanges: ExchangeDeclaration[];
  queues: QueueDeclaration[];
}

const DURABLE_EXCHANGE = (
  name: string,
  type: ExchangeType,
): ExchangeDeclaration => ({
  name,
  type,
  durable: true,
  autoDelete: false,
});

const DURABLE_QUEUE = (
  name: string,
  bindings: QueueBindingDeclaration[],
  args?: Record<string, unknown>,
): QueueDeclaration => ({
  name,
  durable: true,
  autoDelete: false,
  ...(args ? { arguments: args } : {}),
  bindings,
});

/** The producer's entire topology: the durable topic exchange, no queues. */
export function producerTopology(): TopologyDeclaration {
  return {
    exchanges: [DURABLE_EXCHANGE(EVENTS_EXCHANGE, 'topic')],
    queues: [],
  };
}

export interface ConsumerTopologyConfig {
  /** The consumer's own queue name. Never shared with another consumer. */
  queue: string;
  /** The event's topic routing key (also the envelope `type`). */
  eventType: string;
  /** One retry queue per delay: a queue's TTL is fixed. */
  retryDelaysMs: readonly number[];
}

/**
 * The consumer-owned half. The requeue exchange is `direct`, keyed on the queue
 * name: a topic redelivery would fan this consumer's retry out to every other.
 */
export function consumerTopology(
  config: ConsumerTopologyConfig,
): TopologyDeclaration {
  const main = config.queue;
  const dlq = deadLetterQueueName(main);

  const retryQueues = config.retryDelaysMs.map((delay) => {
    const name = retryQueueName(main, delay);
    return DURABLE_QUEUE(
      name,
      [{ exchange: RETRY_EXCHANGE, routingKey: name }],
      {
        'x-message-ttl': delay,
        'x-dead-letter-exchange': REQUEUE_EXCHANGE,
        'x-dead-letter-routing-key': main,
      },
    );
  });

  return {
    exchanges: [
      // Identical to the producer's. Without it a consumer that starts first
      // cannot bind, and misses every event until restarted.
      DURABLE_EXCHANGE(EVENTS_EXCHANGE, 'topic'),
      DURABLE_EXCHANGE(RETRY_EXCHANGE, 'direct'),
      DURABLE_EXCHANGE(REQUEUE_EXCHANGE, 'direct'),
      DURABLE_EXCHANGE(DEAD_LETTER_EXCHANGE, 'direct'),
    ],
    queues: [
      DURABLE_QUEUE(main, [
        { exchange: EVENTS_EXCHANGE, routingKey: config.eventType },
        { exchange: REQUEUE_EXCHANGE, routingKey: main },
      ]),
      ...retryQueues,
      DURABLE_QUEUE(dlq, [
        { exchange: DEAD_LETTER_EXCHANGE, routingKey: main },
      ]),
    ],
  };
}

export function retryQueueName(queue: string, delayMs: number): string {
  return `${queue}.retry.${delayMs}`;
}

export function deadLetterQueueName(queue: string): string {
  return `${queue}.dlq`;
}

/** Idempotent: AMQP asserts are declarative, so every boot can run this. */
export async function declareTopology(
  channel: Pick<Channel, 'assertExchange' | 'assertQueue' | 'bindQueue'>,
  topology: TopologyDeclaration,
): Promise<void> {
  for (const exchange of topology.exchanges) {
    await channel.assertExchange(exchange.name, exchange.type, {
      durable: exchange.durable,
      autoDelete: exchange.autoDelete,
    });
  }

  for (const queue of topology.queues) {
    await channel.assertQueue(queue.name, {
      durable: queue.durable,
      autoDelete: queue.autoDelete,
      ...(queue.arguments ? { arguments: queue.arguments } : {}),
    });
    for (const binding of queue.bindings) {
      await channel.bindQueue(queue.name, binding.exchange, binding.routingKey);
    }
  }
}
