import { Injectable, Logger } from '@nestjs/common';
import { maskEmail } from '@app/common/logging/pii-redactor.js';
import type { EventEnvelope } from '@app/contracts';
import type {
  EventHandlerPort,
  EventHandlingResult,
} from '@app/messaging/consumer/event-handler.port.js';
import { InvalidEventPayloadError } from '@app/messaging/event-errors.js';

/**
 * Track account registration without sending mail.
 * Code emails are sent only for identity.verification-code.issued.
 */
@Injectable()
export class AccountRegisteredConsumer implements EventHandlerPort {
  private readonly logger = new Logger(AccountRegisteredConsumer.name);

  async handle(envelope: EventEnvelope): Promise<EventHandlingResult> {
    const payload = envelope.payload;
    if (
      typeof payload !== 'object' ||
      payload === null ||
      Array.isArray(payload)
    ) {
      throw new InvalidEventPayloadError(
        'The account-registered payload must be an object',
      );
    }
    const record = payload as Record<string, unknown>;
    if (
      typeof record.accountId !== 'string' ||
      record.accountId.length === 0 ||
      typeof record.email !== 'string' ||
      !record.email.includes('@')
    ) {
      throw new InvalidEventPayloadError(
        'The account-registered payload must carry an account id and email',
      );
    }

    this.logger.log(
      `Account ${record.accountId} registered for ${maskEmail(record.email)} (event ${envelope.id})`,
    );
    return { status: 'skipped', skipReason: 'no_email_requested' };
  }
}
