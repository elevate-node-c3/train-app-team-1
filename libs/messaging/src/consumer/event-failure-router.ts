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

export type Disposition = 'ack' | 'nack';

/**
 * Choose retry, dead-letter, or requeue behavior.
 * Return the action; only the consumer may acknowledge the delivery.
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
        // Release the claim before republishing so a retry is not skipped as a duplicate.
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
      // A failed retry publish needs requeue, not acknowledgment.
      this.logger.error(
        `Could not route failed event ${envelope.id}; requeueing: ${messageOf(
          routingError,
        )}`,
      );
      return 'nack';
    }
  }

  /** Malformed envelopes dead-letter immediately, without retry. */
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
