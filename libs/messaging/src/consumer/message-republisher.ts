import { Injectable } from '@nestjs/common';
import type { ConsumeMessage } from 'amqplib';
import type { EventEnvelope } from '@app/contracts';
import { AmqpClientService } from '../amqp-client.service.js';
import {
  ATTEMPT_HEADER,
  CORRELATION_ID_HEADER,
  injectCorrelationId,
} from '../amqp-headers.js';

/**
 * Copies a consumed message onto another exchange over the confirm channel.
 *
 * The consumer decides *where* a failed delivery goes; this knows *how* to put
 * it there.
 */
@Injectable()
export class MessageRepublisher {
  constructor(private readonly amqp: AmqpClientService) {}

  /**
   * A superset of the inbound headers, so a replay keeps its trace and attempt
   * count. The payload is never copied into a header: `code` stays in the body,
   * where pino's key redaction cannot be bypassed by interpolation.
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

  /** The attempt a redelivered copy already carries, else its first. */
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
