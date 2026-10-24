import { Injectable } from '@nestjs/common';
import type { ConfirmChannel } from 'amqplib';
import {
  DOMAIN_EVENTS_EXCHANGE,
  DomainEvent,
  DomainEventPublisher,
} from '@app/contracts';
import { AmqpClientService } from './amqp-client.service.js';
import { injectCorrelationId } from './amqp-headers.js';

/**
 * Publishes domain events to the shared topic exchange, routed by event type.
 * Uses a confirm channel, so `publish` resolves once the broker has the event.
 */
@Injectable()
export class AmqpEventPublisher implements DomainEventPublisher {
  private channel: ConfirmChannel | null = null;

  constructor(private readonly amqp: AmqpClientService) {}

  /**
   * Publishes the event as a persistent message routed by its type.
   * @returns resolves once the broker confirms it; rejects otherwise
   */
  async publish<TPayload>(event: DomainEvent<TPayload>): Promise<void> {
    const channel = await this.getChannel();
    channel.publish(
      DOMAIN_EVENTS_EXCHANGE,
      event.type,
      Buffer.from(JSON.stringify(event)),
      {
        persistent: true,
        contentType: 'application/json',
        messageId: event.eventId,
        headers: injectCorrelationId({}, event.correlationId),
      },
    );
    await channel.waitForConfirms();
  }

  /**
   * Opens the channel and exchange on first use, and again after a close.
   * @returns the open confirm channel
   */
  private async getChannel(): Promise<ConfirmChannel> {
    if (!this.channel) {
      const channel = await this.amqp.createConfirmChannel();
      await channel.assertExchange(DOMAIN_EVENTS_EXCHANGE, 'topic', {
        durable: true,
      });
      // Without an 'error' listener a channel error would crash the process.
      channel.on('error', () => (this.channel = null));
      channel.on('close', () => (this.channel = null));
      this.channel = channel;
    }
    return this.channel;
  }
}
