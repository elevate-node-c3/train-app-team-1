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

  /**
   * The channel the exchange was last asserted on, rather than a boolean.
   *
   * A latch outlives the connection it was set for: against a rebuilt broker
   * the exchange no longer exists, `train.events` is never re-asserted, and
   * every publish fails with a 404 in a permanent loop. Comparing the channel
   * re-asserts exactly when the channel is new — which is precisely when the
   * exchange may be missing — and needs no reconnect subscription to reset.
   */
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
