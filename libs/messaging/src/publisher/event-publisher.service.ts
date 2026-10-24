import { Injectable, Logger } from '@nestjs/common';
import type { EventEnvelope } from '@app/contracts';
import { AmqpClientService } from '../amqp-client.service.js';
import { injectCorrelationId } from '../amqp-headers.js';
import {
  EVENTS_EXCHANGE,
  declareTopology,
  producerTopology,
} from '../amqp-topology.js';

/**
 * Publishes an envelope on the producer's confirm channel and resolves only
 * after the broker has acknowledged it.
 *
 * `mandatory` is deliberately not set. Publishing before any consumer queue
 * exists must succeed and be dropped; otherwise "add a consumer later" would
 * require the producer to tolerate unroutable returns.
 */
@Injectable()
export class EventPublisherService {
  private readonly logger = new Logger(EventPublisherService.name);
  private topologyDeclared = false;

  constructor(private readonly amqp: AmqpClientService) {}

  async publishConfirmed(envelope: EventEnvelope): Promise<void> {
    const channel = await this.amqp.ensureConfirmChannel();

    if (!this.topologyDeclared) {
      await declareTopology(channel, producerTopology());
      this.topologyDeclared = true;
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
