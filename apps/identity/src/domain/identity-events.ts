import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ClsService } from 'nestjs-cls';
import { CORRELATION_ID_KEY } from '@app/common';
import { DOMAIN_EVENT_PUBLISHER, IdentityEventType } from '@app/contracts';
import type { DomainEventPublisher } from '@app/contracts';

/**
 * Publishes identity's events. Each one reports something that has already
 * happened, so a broker failure is logged instead of failing the request.
 */
@Injectable()
export class IdentityEvents {
  private readonly logger = new Logger(IdentityEvents.name);

  constructor(
    @Inject(DOMAIN_EVENT_PUBLISHER)
    private readonly publisher: DomainEventPublisher,
    private readonly cls: ClsService,
  ) {}

  /**
   * Publishes an event with a new id and the request's correlation id.
   * @returns resolves once published; failures are logged, never thrown
   */
  async publish(
    type: IdentityEventType,
    payload: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.publisher.publish({
        eventId: randomUUID(),
        type,
        version: 1,
        occurredAt: new Date().toISOString(),
        correlationId: this.cls.get<string>(CORRELATION_ID_KEY) ?? '',
        payload,
      });
    } catch (err: unknown) {
      // Never log the payload: it can hold an email address or a code.
      this.logger.error(
        `Failed to publish ${type}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
