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
 * The consumer runtime: claim, handle, then ack -- never ack on receipt, or a
 * channel closing mid-handling loses the message. Drains in
 * `beforeApplicationShutdown` while the channel is still open, or a clean deploy
 * becomes duplicate emails. Re-subscribes on reconnect, because
 * `channel.consume` does not survive its channel.
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
  /** Serialises re-attachment so two reconnects cannot both call `consume`. */
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
    // Before cancelling: a shutdown close looks like an outage, and re-attaching
    // would consume messages this process can no longer ack.
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
        // Degrade, don't crash: the liveness probe reports it and a reconnect retries.
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
        // Pass the delivering channel down: a delivery tag is scoped to its
        // channel, so an ack on a replacement addresses nothing.
        this.track(this.handleMessage(subscription, message, channel));
      },
      { noAck: false },
    );

    this.consumers.set(subscription.queueName, { channel, consumerTag });
    this.logger.log(
      `Consuming ${subscription.eventType} from ${subscription.queueName}`,
    );
  }

  /** Chained, not flag-guarded: a skipped attempt leaves the service deaf. */
  private reattach(): Promise<void> {
    const restart = (): Promise<void> => this.restart();
    // Both arms, so one failure does not poison the chain.
    this.restarting = this.restarting.then(restart, restart);
    return this.restarting;
  }

  private async restart(): Promise<void> {
    if (this.draining) {
      return;
    }
    // The old tags died with the old channel; cancelling would throw.
    this.consumers.clear();
    this.logger.warn('AMQP connection was replaced; re-attaching consumers');
    await this.startAll();
  }

  /** A subscription with no entry is a queue nothing is reading. */
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
    // Both settlements; `handleMessage` never lets a rejection escape unlogged.
    void work.then(settle, settle);
  }

  /**
   * Public so a test can drive one delivery. `channel` must be the one the
   * message arrived on, or the ack addresses a tag that channel never saw.
   */
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
      // Someone else handled it, or is handling it. That is a success.
      this.settle(message, channel, 'ack');
      return;
    }

    try {
      const result = await this.cls.run(() => {
        // CLS does not survive an async hop on its own.
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
