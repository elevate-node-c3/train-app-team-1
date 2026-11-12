import { Injectable, Logger } from '@nestjs/common';
import { maskEmail } from '@app/common/logging/pii-redactor.js';
import type { EventEnvelope } from '@app/contracts';
import type {
  EventHandlerPort,
  EventHandlingResult,
} from '@app/messaging/consumer/event-handler.port.js';
import { EmailDeliveryRepository } from '../email-delivery.repository.js';
import { NodemailerEmailSender } from '../email-sender.js';
import { parseVerificationCodeIssuedPayload } from '../verification-code-issued.parser.js';
import { renderVerificationEmail } from '../verification-email.template.js';

/**
 * Send and record delivery before marking the event handled.
 * A crash after SMTP acceptance may cause a duplicate on retry.
 */
@Injectable()
export class VerificationCodeIssuedConsumer implements EventHandlerPort {
  private readonly logger = new Logger(VerificationCodeIssuedConsumer.name);

  constructor(
    private readonly emails: NodemailerEmailSender,
    private readonly deliveries: EmailDeliveryRepository,
  ) {}

  async handle(envelope: EventEnvelope): Promise<EventHandlingResult> {
    const payload = parseVerificationCodeIssuedPayload(envelope);
    const delivery = {
      eventId: envelope.id,
      accountId: payload.accountId,
      recipientEmail: payload.email,
      purpose: payload.purpose,
      issuedAt: new Date(payload.issuedAt),
    };
    const recipient = maskEmail(payload.email);

    // Check expiry here; the event may have waited in the queue.
    if (new Date(payload.expiresAt).getTime() <= Date.now()) {
      await this.deliveries.record({
        ...delivery,
        outcome: 'skipped_expired',
        skipReason: 'code_expired',
      });
      this.logger.warn(
        `Verification code for ${recipient} expired before delivery; skipping (event ${envelope.id})`,
      );
      return { status: 'skipped', skipReason: 'code_expired' };
    }

    const content = renderVerificationEmail({
      code: payload.code,
      language: payload.language,
      purpose: payload.purpose,
    });

    try {
      await this.emails.send({
        to: payload.email,
        subject: content.subject,
        text: content.text,
        html: content.html,
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      await this.deliveries.record({
        ...delivery,
        outcome: 'failed',
        errorMessage: message,
      });
      this.logger.error(
        `Verification email to ${recipient} failed: ${message} (event ${envelope.id})`,
      );
      // Let the consumer release the claim and retry.
      throw error;
    }

    // Measure delivery only after SMTP accepts the email.
    const acceptedAt = new Date();
    const latencyMs = acceptedAt.getTime() - delivery.issuedAt.getTime();
    await this.deliveries.record({
      ...delivery,
      outcome: 'accepted',
      acceptedAt,
      latencyMs,
    });

    this.logger.log(
      `Verification email accepted for ${recipient} in ${latencyMs}ms (event ${envelope.id})`,
    );
    return { status: 'handled' };
  }
}
