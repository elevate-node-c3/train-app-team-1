import { Injectable } from '@nestjs/common';
import type { ConsumeMessage } from 'amqplib';
import type { EventEnvelope } from '@app/contracts';
import { AmqpClientService } from '../amqp-client.service.js';
import {
  ATTEMPT_HEADER,
  CORRELATION_ID_HEADER,
  injectCorrelationId,
} from '../amqp-headers.js';

/** Copy messages to the chosen exchange and wait for broker confirmation. */
@Injectable()
export class MessageRepublisher {
  constructor(private readonly amqp: AmqpClientService) {}

  /**
   * Keep incoming headers, trace IDs, and attempt counts for replay.
   * Never copy payloads into headers, where redaction may miss secret codes.
   */
  headersFor(
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

  /** Keep the carried attempt count, or start at one. */
  attemptFrom(message: ConsumeMessage): number {
    const raw = message.properties.headers?.[ATTEMPT_HEADER];
    const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : raw;
    const parsed = Number.parseInt(String(text ?? '0'), 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : 1;
  }

  /** Resolves only once the broker has confirmed the copy. */
  async republish(
    exchange: string,
    routingKey: string,
    message: ConsumeMessage,
    headers: Record<string, unknown>,
    messageId: string | undefined,
  ): Promise<void> {
    const channel = await this.amqp.ensureConfirmChannel();
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
          message.content,
          {
            persistent:
              (message.properties as { persistent?: boolean }).persistent ??
              true,
            contentType: message.properties.contentType ?? 'application/json',
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
}
