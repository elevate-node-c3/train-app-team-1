import {
  BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import type { Channel, ConsumeMessage } from 'amqplib';
import { CORRELATION_ID_KEY } from '@app/common/correlation/correlation.constants.js';
import type { EventEnvelope } from '@app/contracts';
import { AmqpClientService, type AmqpLiveness } from '../amqp-client.service.js';
import { consumerTopology, declareTopology } from '../amqp-topology.js';
import { messageOf } from '../error-message.js';
import { withTimeout } from '../with-timeout.js';
import {
  claimLeaseSeconds,
  handlerTimeoutMs,
  prefetchSize,
  retryDelaysFor,
} from './consumer-config.js';
import {
  EventFailureRouter,
  type Disposition,
} from './event-failure-router.js';
import {
  EVENT_SUBSCRIPTIONS,
  type EventSubscription,
} from './event-subscription.js';
import { parseEventEnvelope } from './parse-envelope.js';
import {
  PROCESSED_EVENT_STORE,
  type ProcessedEventStorePort,
} from './processed-event.port.js';

/**
 * Claim, handle, then acknowledge; never acknowledge before side effects finish.
 * Drain before shutdown closes the channel, and resubscribe after reconnects.
 */
@Injectable()
export class EventConsumerService
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private readonly logger = new Logger(EventConsumerService.name);
  private readonly inFlight = new Set<Promise<void>>();
  private readonly consumers = new Map<
    string,
    { channel: Channel; consumerTag: string }
  >();
  private draining = false;
  private unsubscribeReconnect: (() => void) | null = null;
  private unregisterLiveness: (() => void) | null = null;
  /** Queue reattachment so reconnects cannot create duplicate consumers. */
  private restarting: Promise<void> = Promise.resolve();

  constructor(
    @Inject(EVENT_SUBSCRIPTIONS)
    private readonly subscriptions: EventSubscription[],
    private readonly amqp: AmqpClientService,
    @Inject(PROCESSED_EVENT_STORE)
    private readonly processedEvents: ProcessedEventStorePort,
    private readonly cls: ClsService,
    private readonly failures: EventFailureRouter,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    this.unsubscribeReconnect = this.amqp.onReconnect(() => this.reattach());
    this.unregisterLiveness = this.amqp.registerLivenessProbe(() =>
      this.liveness(),
    );
    await this.startAll();
  }

  async beforeApplicationShutdown(): Promise<void> {
    // Stop reconnect hooks before draining to avoid new work during shutdown.
    this.draining = true;
    this.unsubscribeReconnect?.();
    this.unsubscribeReconnect = null;
    this.unregisterLiveness?.();
    this.unregisterLiveness = null;

    for (const { channel, consumerTag } of this.consumers.values()) {
      try {
        await channel.cancel(consumerTag);
      } catch {
        // A cancelled tag or a closed channel is already drained.
      }
    }
    this.consumers.clear();
    await Promise.allSettled(this.inFlight);
  }

  private async startAll(): Promise<void> {
    for (const subscription of this.subscriptions) {
      try {
        await this.startSubscription(subscription);
      } catch (error: unknown) {
        // Record the failure without crashing; reconnects retry subscription setup.
        this.logger.error(
          `Consumer for ${subscription.eventType} did not start: ${messageOf(
            error,
          )}`,
        );
      }
    }
  }

  private async startSubscription(
    subscription: EventSubscription,
  ): Promise<void> {
    const channel = await this.amqp.ensureChannel();

    await declareTopology(
      channel,
      consumerTopology({
        queue: subscription.queueName,
        eventType: subscription.eventType,
        retryDelaysMs: retryDelaysFor(subscription),
      }),
    );
    await channel.prefetch(prefetchSize());

    const { consumerTag } = await channel.consume(
      subscription.queueName,
      (message) => {
        if (!message) return;
        // Acknowledge on the original delivery channel, never its replacement.
        this.track(this.handleMessage(subscription, message, channel));
      },
      { noAck: false },
    );

    this.consumers.set(subscription.queueName, { channel, consumerTag });
    this.logger.log(
      `Consuming ${subscription.eventType} from ${subscription.queueName}`,
    );
  }

  /** Chain reconnects so none is skipped after a previous failure. */
  private reattach(): Promise<void> {
    const restart = (): Promise<void> => this.restart();
    // Continue the chain after success or failure.
    this.restarting = this.restarting.then(restart, restart);
    return this.restarting;
  }

  private async restart(): Promise<void> {
    if (this.draining) {
      return;
    }
    // Old delivery tags belong to the closed channel.
    this.consumers.clear();
    this.logger.warn('AMQP connection was replaced; re-attaching consumers');
    await this.startAll();
  }

  /** A missing subscription means the queue has no consumer. */
  private liveness(): AmqpLiveness {
    if (this.draining) {
      return { healthy: true };
    }
    const silent = this.subscriptions
      .filter((subscription) => !this.consumers.has(subscription.queueName))
      .map((subscription) => subscription.queueName);

    return silent.length === 0
      ? { healthy: true }
      : { healthy: false, detail: `Not consuming: ${silent.join(', ')}` };
  }

  private track(work: Promise<void>): void {
    this.inFlight.add(work);
    const settle = (): void => {
      this.inFlight.delete(work);
    };
    // Handle both promise outcomes so no rejection goes unlogged.
    void work.then(settle, settle);
  }

  /** Testable message entry point; acknowledgments must use its original channel. */
  async handleMessage(
    subscription: EventSubscription,
    message: ConsumeMessage,
    channel: Channel,
  ): Promise<void> {
    let envelope: EventEnvelope;
    try {
      envelope = parseEventEnvelope(message.content, {
        type: subscription.eventType,
        version: subscription.version,
      });
    } catch (error: unknown) {
      const disposition = await this.failures.routeUnparsed(
        subscription,
        message,
        error,
      );
      this.settle(message, channel, disposition);
      return;
    }

    let attempt: number | null;
    try {
      attempt = await this.processedEvents.claim({
        eventId: envelope.id,
        eventType: envelope.type,
        redelivered: message.fields.redelivered,
        leaseSeconds: claimLeaseSeconds(),
      });
    } catch (error: unknown) {
      this.logger.error(
        `Claim failed for ${envelope.id}; requeueing: ${messageOf(error)}`,
      );
      this.settle(message, channel, 'nack');
      return;
    }

    if (attempt === null) {
      // Another worker already owns or handled this event.
      this.settle(message, channel, 'ack');
      return;
    }

    try {
      const result = await this.cls.run(() => {
        // Restore tracing context across async delivery.
        this.cls.set(CORRELATION_ID_KEY, envelope.correlationId);
        return withTimeout(
          subscription.handler.handle(envelope, attempt as number),
          handlerTimeoutMs(),
        );
      });

      if (result.status === 'skipped') {
        await this.processedEvents.markSkipped(
          envelope.id,
          result.skipReason ?? 'skipped',
        );
      } else {
        await this.processedEvents.markHandled(envelope.id);
      }

      // Strictly after the side effect and its record.
      this.settle(message, channel, 'ack');
    } catch (error: unknown) {
      const disposition = await this.failures.route(
        subscription,
        message,
        envelope,
        attempt,
        error,
      );
      this.settle(message, channel, disposition);
    }
  }

  private settle(
    message: ConsumeMessage,
    channel: Channel,
    disposition: Disposition,
  ): void {
    try {
      if (disposition === 'ack') {
        channel.ack(message);
      } else {
        channel.nack(message, false, true);
      }
    } catch (error: unknown) {
      this.logger.error(
        `Could not ${disposition} a delivery; the broker will redeliver: ${messageOf(
          error,
        )}`,
      );
    }
  }
}
