import { Injectable, Logger } from '@nestjs/common';
import type { ConfirmChannel } from 'amqplib';
import type { EventEnvelope } from '@app/contracts';
import { AmqpClientService } from '../amqp-client.service.js';
import { injectCorrelationId } from '../amqp-headers.js';
import {
  EVENTS_EXCHANGE,
  declareTopology,
  producerTopology,
} from '../amqp-topology.js';

/**
 * Resolve only after the broker confirms publication.
 * No mandatory flag: events without a consumer queue may be dropped.
 */
@Injectable()
export class EventPublisherService {
  private readonly logger = new Logger(EventPublisherService.name);

  /** Remember the channel, not a flag, so rebuilt brokers get the exchange declaration again. */
  private topologyChannel: ConfirmChannel | null = null;

  constructor(private readonly amqp: AmqpClientService) {}

  async publishConfirmed(envelope: EventEnvelope): Promise<void> {
    const channel = await this.amqp.ensureConfirmChannel();

    if (this.topologyChannel !== channel) {
      await declareTopology(channel, producerTopology());
      this.topologyChannel = channel;
      this.logger.log('Producer topology asserted');
    }

    const body = Buffer.from(JSON.stringify(envelope));
    await new Promise<void>((resolve, reject) => {
      try {
        channel.publish(
          EVENTS_EXCHANGE,
          envelope.type,
          body,
          {
            persistent: true,
            contentType: 'application/json',
            contentEncoding: 'utf-8',
            messageId: envelope.id,
            type: envelope.type,
            timestamp: Math.floor(Date.now() / 1000),
            headers: injectCorrelationId(envelope.correlationId),
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
}
