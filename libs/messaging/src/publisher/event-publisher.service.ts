import { once } from 'node:events';
import { Injectable, Logger } from '@nestjs/common';
import type { ConfirmChannel } from 'amqplib';
import { EVENT_TYPES, type EventEnvelope } from '@app/contracts';
import { AmqpClientService } from '../amqp-client.service.js';
import { injectCorrelationId } from '../amqp-headers.js';
import {
  EVENTS_EXCHANGE,
  declareTopology,
  producerTopology,
} from '../amqp-topology.js';

interface PendingConfirmation {
  mandatory: boolean;
  returned: Error | null;
  finish: (error?: unknown) => void;
}

/**
 * Resolve only after the broker confirms publication.
 * Hold lifecycle events also require a route; consumers still own their queues.
 */
@Injectable()
export class EventPublisherService {
  private readonly logger = new Logger(EventPublisherService.name);

  /** Remember the channel, not a flag, so rebuilt brokers get the exchange declaration again. */
  private topologyChannel: ConfirmChannel | null = null;
  private topologyReady: Promise<void> | null = null;
  private readonly drains = new WeakMap<ConfirmChannel, Promise<void>>();
  private readonly pending = new WeakMap<
    ConfirmChannel,
    Map<string, PendingConfirmation>
  >();
  private readonly pendingCleanup = new WeakMap<ConfirmChannel, () => void>();
  private static readonly MANDATORY_EVENTS = new Set<string>([
    EVENT_TYPES.holdHeld,
    EVENT_TYPES.holdReleased,
    EVENT_TYPES.holdExpired,
    EVENT_TYPES.holdExtended,
  ]);

  constructor(private readonly amqp: AmqpClientService) {}

  async publishConfirmed(envelope: EventEnvelope): Promise<void> {
    const abort = new AbortController();
    const timeoutMs = this.confirmTimeoutMs();
    let channel: ConfirmChannel | undefined;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        const error = new Error(
          `AMQP publication timed out after ${timeoutMs}ms`,
        );
        // Bound the whole attempt and prevent a late channel acquisition from publishing.
        abort.abort(error);
        if (channel) this.amqp.invalidateConfirmChannel(channel);
        reject(error);
      }, timeoutMs);
    });

    try {
      await Promise.race([
        (async () => {
          const current = await this.amqp.ensureConfirmChannel();
          channel = current;
          abort.signal.throwIfAborted();

          if (this.topologyChannel !== current) {
            this.topologyChannel = current;
            this.topologyReady = declareTopology(current, producerTopology())
              .then(() => {
                this.logger.log('Producer topology asserted');
              })
              .catch((error: unknown) => {
                if (this.topologyChannel === current) {
                  this.topologyChannel = null;
                  this.topologyReady = null;
                }
                throw error;
              });
          }
          await this.topologyReady;
          abort.signal.throwIfAborted();

          // Pause concurrent event publishes while the channel buffer drains.
          while (this.drains.has(current)) {
            await this.drains.get(current);
            abort.signal.throwIfAborted();
          }

          const mandatory = EventPublisherService.MANDATORY_EVENTS.has(
            envelope.type,
          );
          let writable = true;
          const confirmation = new Promise<void>((resolve, reject) => {
            const pending = this.pendingFor(current);
            if (pending.has(envelope.id)) {
              reject(
                new Error(`AMQP event ${envelope.id} is already in flight`),
              );
              return;
            }
            let settled = false;
            const attempt: PendingConfirmation = {
              mandatory,
              returned: null,
              finish: (error?: unknown): void => {
                if (settled) return;
                settled = true;
                pending.delete(envelope.id);
                abort.signal.removeEventListener('abort', onAbort);
                // Remove only publisher-owned listeners, never amqplib's handlers.
                if (pending.size === 0) this.pendingCleanup.get(current)?.();
                if (error != null) reject(error);
                else resolve();
              },
            };
            const onAbort = (): void => attempt.finish(abort.signal.reason);
            pending.set(envelope.id, attempt);
            abort.signal.addEventListener('abort', onAbort, { once: true });

            try {
              writable = current.publish(
                EVENTS_EXCHANGE,
                envelope.type,
                Buffer.from(JSON.stringify(envelope)),
                {
                  persistent: true,
                  ...(mandatory ? { mandatory: true } : {}),
                  contentType: 'application/json',
                  contentEncoding: 'utf-8',
                  messageId: envelope.id,
                  type: envelope.type,
                  timestamp: Math.floor(Date.now() / 1000),
                  headers: injectCorrelationId(envelope.correlationId),
                },
                // AMQP orders mandatory returns before their corresponding confirm.
                (error) => attempt.finish(error ?? attempt.returned),
              );
            } catch (error: unknown) {
              attempt.finish(error);
            }
          });

          if (!writable) {
            const drain = once(current, 'drain', { signal: abort.signal })
              .then(() => {})
              .finally(() => {
                if (this.drains.get(current) === drain)
                  this.drains.delete(current);
              });
            this.drains.set(current, drain);
            await Promise.all([confirmation, drain]);
          } else {
            await confirmation;
          }
        })(),
        timeout,
      ]);
    } finally {
      clearTimeout(timer);
      abort.abort();
    }
  }

  /** One listener set per channel, not one per concurrent publication. */
  private pendingFor(
    channel: ConfirmChannel,
  ): Map<string, PendingConfirmation> {
    const existing = this.pending.get(channel);
    if (existing) return existing;
    const pending = new Map<string, PendingConfirmation>();
    const onReturn = (message: {
      properties: { messageId?: string };
      fields: { replyCode: number; replyText: string };
    }): void => {
      const attempt = pending.get(message.properties.messageId ?? '');
      if (!attempt?.mandatory) return;
      attempt.returned = new Error(
        `AMQP mandatory return ${message.fields.replyCode} ${message.fields.replyText} for ${message.properties.messageId}`,
      );
    };
    const onError = (error: unknown): void => {
      for (const attempt of pending.values()) attempt.finish(error);
    };
    const onClose = (): void =>
      onError(new Error('AMQP confirm channel closed'));
    const onDrained = (): void => {
      channel.removeListener('return', onReturn);
      channel.removeListener('error', onError);
      channel.removeListener('close', onClose);
      this.pending.delete(channel);
      this.pendingCleanup.delete(channel);
    };
    channel.on('return', onReturn);
    channel.on('error', onError);
    channel.on('close', onClose);
    this.pending.set(channel, pending);
    this.pendingCleanup.set(channel, onDrained);
    return pending;
  }

  private confirmTimeoutMs(): number {
    const raw = Number(process.env.AMQP_PUBLISH_CONFIRM_TIMEOUT_MS);
    return Number.isInteger(raw) && raw > 0 ? Math.min(raw, 60_000) : 5_000;
  }
}
