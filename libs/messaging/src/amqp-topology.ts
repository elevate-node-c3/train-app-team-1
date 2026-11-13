import type { Channel } from 'amqplib';

/**
 * Producers declare the shared exchange; each consumer owns its queues.
 * Consumers repeat the same exchange declaration so startup order is safe.
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
  /** Omit unused AMQP arguments. */
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

/** Producer owns only the durable topic exchange. */
export function producerTopology(): TopologyDeclaration {
  return {
    exchanges: [DURABLE_EXCHANGE(EVENTS_EXCHANGE, 'topic')],
    queues: [],
  };
}

export interface ConsumerTopologyConfig {
  /** Queue belongs to one consumer only. */
  queue: string;
  /** Event type and topic routing key. */
  eventType: string;
  /** One retry queue per delay: a queue's TTL is fixed. */
  retryDelaysMs: readonly number[];
}

/** Direct retries target this queue only, not every consumer of the event. */
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
      // Match the producer's declaration so consumers can start first.
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

/** Repeated AMQP declarations are safe on every startup. */
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
