import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConsumeMessage } from 'amqplib';
import type { EventEnvelope } from '@app/contracts';
import { DEATH_REASON_HEADER } from '../amqp-headers.js';
import {
  DEAD_LETTER_EXCHANGE,
  RETRY_EXCHANGE,
  retryQueueName,
} from '../amqp-topology.js';
import { messageOf } from '../error-message.js';
import {
  isPermanentEventError,
  type PermanentEventReason,
} from '../event-errors.js';
import { retryDelaysFor } from './consumer-config.js';
import type { EventSubscription } from './event-subscription.js';
import { MessageRepublisher } from './message-republisher.js';
import {
  PROCESSED_EVENT_STORE,
  type ProcessedEventStorePort,
} from './processed-event.port.js';

/** What the caller should do with the delivery once routing is decided. */
export type Disposition = 'ack' | 'nack';

/**
 * Decides where a failed delivery goes: a retry queue, the dead letter
 * exchange, or back on the queue.
 *
 * Returns a disposition instead of acking, so it needs no channel and the
 * consumer keeps sole ownership of the delivery tag.
 */
@Injectable()
export class EventFailureRouter {
  private readonly logger = new Logger(EventFailureRouter.name);

  constructor(
    private readonly republisher: MessageRepublisher,
    @Inject(PROCESSED_EVENT_STORE)
    private readonly processedEvents: ProcessedEventStorePort,
  ) {}

  async route(
    subscription: EventSubscription,
    message: ConsumeMessage,
    envelope: EventEnvelope,
    attempt: number,
    error: unknown,
  ): Promise<Disposition> {
    const reason = messageOf(error);
    const headers = this.republisher.headersFor(message, envelope, attempt);

    try {
      if (isPermanentEventError(error)) {
        return await this.deadLetter(
          subscription,
          message,
          envelope,
          headers,
          reason,
          error.reason,
        );
      }

      const delays = retryDelaysFor(subscription);
      if (attempt <= delays.length) {
        // Load-bearing order: release the lease BEFORE the retry copy can
        // arrive, or the 1s copy meets the 60s lease, the claim is refused,
        // and the email is dropped on the first SMTP blip.
        await this.processedEvents.markFailed(envelope.id, reason);
        await this.republisher.republish(
          RETRY_EXCHANGE,
          retryQueueName(subscription.queueName, delays[attempt - 1]),
          message,
          headers,
          envelope.id,
        );
        return 'ack';
      }

      return await this.deadLetter(
        subscription,
        message,
        envelope,
        headers,
        reason,
        'retries-exhausted',
      );
    } catch (routingError: unknown) {
      // The republish *is* the retry; acking now would lose the message.
      this.logger.error(
        `Could not route failed event ${envelope.id}; requeueing: ${messageOf(
          routingError,
        )}`,
      );
      return 'nack';
    }
  }

  /** An unreadable envelope cannot be retried, so it dead-letters at once. */
  async routeUnparsed(
    subscription: EventSubscription,
    message: ConsumeMessage,
    error: unknown,
  ): Promise<Disposition> {
    const reason: PermanentEventReason = isPermanentEventError(error)
      ? error.reason
      : 'invalid-payload';
    const headers = this.republisher.headersFor(
      message,
      undefined,
      this.republisher.attemptFrom(message),
    );

    try {
      await this.republisher.republish(
        DEAD_LETTER_EXCHANGE,
        subscription.queueName,
        message,
        { ...headers, [DEATH_REASON_HEADER]: reason },
        undefined,
      );
      return 'ack';
    } catch (routingError: unknown) {
      this.logger.error(
        `Could not dead-letter an unreadable message; requeueing: ${messageOf(
          routingError,
        )}`,
      );
      return 'nack';
    }
  }

  private async deadLetter(
    subscription: EventSubscription,
    message: ConsumeMessage,
    envelope: EventEnvelope,
    headers: Record<string, unknown>,
    reason: string,
    deathReason: string,
  ): Promise<Disposition> {
    await this.processedEvents.markFailed(envelope.id, reason);
    await this.republisher.republish(
      DEAD_LETTER_EXCHANGE,
      subscription.queueName,
      message,
      { ...headers, [DEATH_REASON_HEADER]: deathReason },
      envelope.id,
    );
    return 'ack';
  }
}
