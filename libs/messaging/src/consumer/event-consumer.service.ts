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
 * The consumer runtime: claim, handle, then ack.
 *
 * A message is acked only once the side effect and its bookkeeping are done;
 * acking on receipt would lose it when the channel closes mid-handling.
 *
 * Draining happens in `beforeApplicationShutdown`, while the channel is still
 * open. `onApplicationShutdown` runs after dispose, when every ack would fail
 * silently and a clean deploy would become duplicate emails.
 *
 * `channel.consume` does not survive its channel, so subscribing only at
 * bootstrap left this service connected and deaf after a broker restart.
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
    // Before cancelling: a channel closing on the way out looks exactly like an
    // outage, and re-attaching would consume messages this process can no
    // longer ack.
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
        // Degrade, don't crash: the liveness probe reports the missing queue
        // and the next connection replacement retries this.
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
        // The delivering channel is passed down rather than re-resolved: a
        // delivery tag is scoped to its channel, so after a reconnect an ack
        // on the replacement addresses nothing and the broker redelivers.
        this.track(this.handleMessage(subscription, message, channel));
      },
      { noAck: false },
    );

    this.consumers.set(subscription.queueName, { channel, consumerTag });
    this.logger.log(
      `Consuming ${subscription.eventType} from ${subscription.queueName}`,
    );
  }

  /**
   * Chained rather than guarded by a flag: a skipped attempt would leave the
   * service deaf until the next outage, which may never come.
   */
  private reattach(): Promise<void> {
    const restart = (): Promise<void> => this.restart();
    // Both arms, so one failed attempt does not poison the chain.
    this.restarting = this.restarting.then(restart, restart);
    return this.restarting;
  }

  private async restart(): Promise<void> {
    if (this.draining) {
      return;
    }
    // The old tags died with the old channel; cancelling them would throw.
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
   * Public so a unit test can drive one delivery without a channel callback.
   *
   * `channel` must be the one the message arrived on — resolving it here is how
   * an ack ends up on a channel that never saw the delivery tag.
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
        // An async hop is exactly where CLS does not reach on its own.
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
