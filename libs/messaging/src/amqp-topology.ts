import type { Channel } from 'amqplib';

/**
 * The AMQP topology as data, so it can be asserted and reviewed rather than
 * discovered in a management console.
 *
 * Ownership is the load-bearing rule:
 * - the producer declares `train.events` and nothing else;
 * - a consumer declares its retry/requeue/DLX exchanges and its own queues.
 *
 * Declaring a consumer's queue on the producer's side would mean the producer
 * knows its consumers, which is exactly the coupling the backbone removes.
 *
 * A consumer also re-asserts `train.events` with the producer's exact
 * parameters. The exchange's definition is still the producer's; the duplicate
 * assertion is what makes startup order irrelevant, because binding to an
 * exchange that does not exist yet fails with 404 and leaves the consumer
 * subscribed to nothing.
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

const DURABLE_EXCHANGE = (name: string, type: ExchangeType): ExchangeDeclaration => ({
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
  /** One retry queue per delay; the TTL is fixed per queue by design. */
  retryDelaysMs: readonly number[];
}

/**
 * The consumer-owned half of the topology.
 *
 * The requeue exchange is `direct` and keyed on the main queue's name. A topic
 * redelivery on the original routing key would fan this consumer's retry out to
 * every other consumer later bound to that key, so each consumer would see a
 * retry it did not ask for.
 */
export function consumerTopology(
  config: ConsumerTopologyConfig,
): TopologyDeclaration {
  const main = config.queue;
  const dlq = `${main}.dlq`;

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
      // Idempotent and identical to the producer's declaration. Without it, a
      // consumer that starts first (e.g. `docker compose up`) cannot bind and
      // never retries, so it would miss every event until manually restarted.
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

/**
 * Asserts every declaration idempotently. AMQP asserts are declarative, so
 * running this on every boot is safe and makes a rebuilt broker identical to
 * the one a reviewer saw.
 */
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
      await channel.bindQueue(
        queue.name,
        binding.exchange,
        binding.routingKey,
      );
    }
  }
}
