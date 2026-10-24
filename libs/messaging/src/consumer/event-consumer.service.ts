import {
  BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import type {
  Channel,
  ConsumeMessage,
  ConfirmChannel,
} from 'amqplib';
import { CORRELATION_ID_KEY } from '@app/common/correlation/correlation.constants.js';
import {
  DEFAULT_EVENT_RETRY_DELAYS_MS,
  NOTIFICATION_DEFAULTS,
} from '@app/common/config/env.defaults.js';
import type { EventEnvelope } from '@app/contracts';
import { AmqpClientService } from '../amqp-client.service.js';
import {
  ATTEMPT_HEADER,
  CORRELATION_ID_HEADER,
  DEATH_REASON_HEADER,
  injectCorrelationId,
  type DeathReason,
} from '../amqp-headers.js';
import {
  DEAD_LETTER_EXCHANGE,
  RETRY_EXCHANGE,
  consumerTopology,
  declareTopology,
  retryQueueName,
} from '../amqp-topology.js';
import {
  isPermanentEventError,
  type PermanentEventReason,
} from '../event-errors.js';
import {
  EVENT_SUBSCRIPTIONS,
  type EventSubscription,
} from './event-subscription.js';
import {
  PROCESSED_EVENT_STORE,
  type ProcessedEventStorePort,
} from './processed-event.port.js';
import { parseEventEnvelope } from './parse-envelope.js';

/**
 * The consumer runtime: classify, claim, handle, then ack.
 *
 * The message is acked only after the side effect and its bookkeeping are
 * finished. An unacked message whose channel closes is redelivered; acking on
 * receipt would lose it instead.
 *
 * Draining happens in `beforeApplicationShutdown` — Nest calls it while
 * `AmqpClientService` still holds the channel. `onApplicationShutdown` runs
 * after `dispose()`, by which point every ack would fail silently and a clean
 * deploy would become a batch of duplicate emails.
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

  constructor(
    @Inject(EVENT_SUBSCRIPTIONS)
    private readonly subscriptions: EventSubscription[],
    private readonly amqp: AmqpClientService,
    @Inject(PROCESSED_EVENT_STORE)
    private readonly processedEvents: ProcessedEventStorePort,
    private readonly cls: ClsService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    for (const subscription of this.subscriptions) {
      try {
        await this.startSubscription(subscription);
      } catch (error: unknown) {
        // Degrade, don't crash: readiness already reports the broker.
        this.logger.error(
          `Consumer for ${subscription.eventType} did not start: ${
            error instanceof Error ? error.message : String(error)
          }`,
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
        retryDelaysMs: this.retryDelays(subscription),
      }),
    );
    await channel.prefetch(this.prefetch());

    const { consumerTag } = await channel.consume(
      subscription.queueName,
      (message) => {
        if (!message) return;
        this.track(this.handleMessage(subscription, message));
      },
      { noAck: false },
    );

    this.consumers.set(subscription.queueName, { channel, consumerTag });
    this.logger.log(
      `Consuming ${subscription.eventType} from ${subscription.queueName}`,
    );
  }

  private track(work: Promise<void>): void {
    this.inFlight.add(work);
    const settle = (): void => {
      this.inFlight.delete(work);
    };
    // Both settlements are handled; the rejection was already logged by
    // `handleMessage`, which never lets one escape.
    void work.then(settle, settle);
  }

  async beforeApplicationShutdown(): Promise<void> {
    for (const { channel, consumerTag } of this.consumers.values()) {
      try {
        await channel.cancel(consumerTag);
      } catch {
        // A cancelled consumer tag or a closed channel is already drained.
      }
    }
    await Promise.allSettled(this.inFlight);
  }

  /**
   * Public so unit tests can drive one delivery without timers or a channel
   * callback. The callback above is a thin tracking wrapper around it.
   */
  async handleMessage(
    subscription: EventSubscription,
    message: ConsumeMessage,
  ): Promise<void> {
    const channel = await this.amqp.ensureChannel();

    let envelope: EventEnvelope;
    try {
      envelope = parseEventEnvelope(message.content, {
        type: subscription.eventType,
        version: subscription.version,
      });
    } catch (error: unknown) {
      await this.deadLetterUnparsed(subscription, message, channel, error);
      return;
    }

    let attempt: number | null;
    try {
      attempt = await this.processedEvents.claim({
        eventId: envelope.id,
        eventType: envelope.type,
        redelivered: message.fields.redelivered,
        leaseSeconds: this.claimLeaseSeconds(),
      });
    } catch (error: unknown) {
      this.logger.error(
        `Claim failed for ${envelope.id}; requeueing: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      this.nack(message, channel);
      return;
    }

    if (attempt === null) {
      // Someone else handled it, or is handling it. That is a success.
      this.ack(message, channel);
      return;
    }

    try {
      const result = await this.cls.run(() => {
        // An async hop is exactly where CLS does not reach on its own.
        this.cls.set(CORRELATION_ID_KEY, envelope.correlationId);
        return this.withTimeout(
          subscription.handler.handle(envelope, attempt as number),
          this.handlerTimeoutMs(),
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

      // Ack strictly after the side effect and its record.
      this.ack(message, channel);
    } catch (error: unknown) {
      await this.handleFailure(
        subscription,
        message,
        channel,
        envelope,
        attempt,
        error,
      );
    }
  }

  private async handleFailure(
    subscription: EventSubscription,
    message: ConsumeMessage,
    channel: Channel,
    envelope: EventEnvelope,
    attempt: number,
    error: unknown,
  ): Promise<void> {
    const text = error instanceof Error ? error.message : String(error);
    const inboxHeaders = this.headersFrom(message, envelope, attempt);

    try {
      if (isPermanentEventError(error)) {
        await this.processedEvents.markFailed(envelope.id, text);
        await this.publishConfirmed(
          DEAD_LETTER_EXCHANGE,
          subscription.queueName,
          message,
          {
            ...inboxHeaders,
            [DEATH_REASON_HEADER]: error.reason,
          },
          envelope.id,
        );
        this.ack(message, channel);
        return;
      }

      const delays = this.retryDelays(subscription);
      if (attempt <= delays.length) {
        // ADR-0003's load-bearing order: release the lease BEFORE the retry
        // copy can arrive. Otherwise the 1s copy meets the 60s lease, the
        // claim is refused, and the email is dropped on the first SMTP blip.
        await this.processedEvents.markFailed(envelope.id, text);
        const delay = delays[attempt - 1];
        await this.publishConfirmed(
          RETRY_EXCHANGE,
          retryQueueName(subscription.queueName, delay),
          message,
          inboxHeaders,
          envelope.id,
        );
        this.ack(message, channel);
        return;
      }

      await this.processedEvents.markFailed(envelope.id, text);
      await this.publishConfirmed(
        DEAD_LETTER_EXCHANGE,
        subscription.queueName,
        message,
        {
          ...inboxHeaders,
          [DEATH_REASON_HEADER]: 'retries-exhausted',
        },
        envelope.id,
      );
      this.ack(message, channel);
    } catch (routingError: unknown) {
      // The republish is the retry. If it failed, acking would lose the
      // message, so nack with requeue and never ack.
      this.logger.error(
        `Could not route failed event ${envelope.id}; requeueing: ${
          routingError instanceof Error
            ? routingError.message
            : String(routingError)
        }`,
      );
      this.nack(message, channel);
    }
  }

  private async deadLetterUnparsed(
    subscription: EventSubscription,
    message: ConsumeMessage,
    channel: Channel,
    error: unknown,
  ): Promise<void> {
    const reason: PermanentEventReason = isPermanentEventError(error)
      ? error.reason
      : 'invalid-payload';
    const headers = this.headersFrom(
      message,
      undefined,
      this.attemptHeaderFrom(message),
    );

    try {
      await this.publishConfirmed(
        DEAD_LETTER_EXCHANGE,
        subscription.queueName,
        message,
        { ...headers, [DEATH_REASON_HEADER]: reason },
        undefined,
      );
      this.ack(message, channel);
    } catch (routingError: unknown) {
      this.logger.error(
        `Could not dead-letter an unreadable message; requeueing: ${
          routingError instanceof Error
            ? routingError.message
            : String(routingError)
        }`,
      );
      this.nack(message, channel);
    }
  }

  /**
   * A superset of the inbound headers, so a replay keeps its trace and its
   * attempt count. The payload is never copied into a header: `code` stays in
   * the body, where pino's key redaction cannot be bypassed by interpolation.
   */
  private headersFrom(
    message: ConsumeMessage,
    envelope: EventEnvelope | undefined,
    attempt: number,
  ): Record<string, unknown> {
    const headers: Record<string, unknown> = {
      ...message.properties.headers,
      [ATTEMPT_HEADER]: String(attempt),
    };
    if (envelope && headers[CORRELATION_ID_HEADER] === undefined) {
      headers[CORRELATION_ID_HEADER] = envelope.correlationId;
    }
    return headers;
  }

  private attemptHeaderFrom(message: ConsumeMessage): number {
    const raw = message.properties.headers?.[ATTEMPT_HEADER];
    const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : raw;
    const parsed = Number.parseInt(String(text ?? '0'), 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : 1;
  }

  private async publishConfirmed(
    exchange: string,
    routingKey: string,
    message: ConsumeMessage,
    headers: Record<string, unknown>,
    messageId: string | undefined,
  ): Promise<void> {
    const channel: ConfirmChannel = await this.amqp.ensureConfirmChannel();
    const body = message.content;
    const rawCorrelation = headers[CORRELATION_ID_HEADER];
    const correlationId =
      typeof rawCorrelation === 'string'
        ? rawCorrelation
        : (messageId ?? 'unknown');
    await new Promise<void>((resolve, reject) => {
      try {
        channel.publish(
          exchange,
          routingKey,
          body,
          {
            persistent:
              (message.properties as { persistent?: boolean }).persistent ??
              true,
            contentType:
              message.properties.contentType ?? 'application/json',
            contentEncoding: message.properties.contentEncoding ?? 'utf-8',
            ...(messageId ? { messageId } : {}),
            type: message.properties.type,
            timestamp: Math.floor(Date.now() / 1000),
            headers: injectCorrelationId(correlationId, headers),
          },
          (error) => {
            if (error) {
              reject(error);
              return;
            }
            resolve();
          },
        );
      } catch (error) {
        reject(error);
      }
    });
  }

  private ack(message: ConsumeMessage, channel: Channel): void {
    try {
      channel.ack(message);
    } catch (error: unknown) {
      this.logger.error(
        `Ack failed; the broker will redeliver: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private nack(message: ConsumeMessage, channel: Channel): void {
    try {
      channel.nack(message, false, true);
    } catch (error: unknown) {
      this.logger.error(
        `Nack failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private async withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`Event handler timed out after ${ms}ms`));
      }, ms);
      timer.unref?.();
    });
    try {
      return await Promise.race([work, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private retryDelays(subscription: EventSubscription): readonly number[] {
    if (subscription.retryDelaysMs) {
      return subscription.retryDelaysMs;
    }
    const raw =
      process.env.EVENT_RETRY_DELAYS_MS ?? NOTIFICATION_DEFAULTS.retryDelays;
    const parsed = raw
      .split(',')
      .map((part) => Number(part.trim()))
      .filter((value) => Number.isInteger(value) && value >= 0);
    return parsed.length > 0 ? parsed : DEFAULT_EVENT_RETRY_DELAYS_MS;
  }

  private handlerTimeoutMs(): number {
    const raw = Number(process.env.EVENT_HANDLER_TIMEOUT_MS);
    return Number.isFinite(raw) && raw > 0
      ? raw
      : NOTIFICATION_DEFAULTS.handlerTimeoutMs;
  }

  private prefetch(): number {
    const raw = Number(process.env.EVENT_PREFETCH);
    return Number.isInteger(raw) && raw > 0
      ? raw
      : NOTIFICATION_DEFAULTS.prefetch;
  }

  private claimLeaseSeconds(): number {
    const raw = Number(process.env.EVENT_CLAIM_LEASE_SECONDS);
    return Number.isInteger(raw) && raw > 0
      ? raw
      : NOTIFICATION_DEFAULTS.claimLeaseSeconds;
  }
}

export type { DeathReason };
