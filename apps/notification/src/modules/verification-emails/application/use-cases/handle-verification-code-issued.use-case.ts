import { Inject, Injectable, Logger } from '@nestjs/common';
import { maskEmail } from '@app/common/logging/pii-redactor.js';
import type { EventEnvelope } from '@app/contracts';
import type {
  EventHandlerPort,
  EventHandlingResult,
} from '@app/messaging/consumer/event-handler.port.js';
import {
  EMAIL_DELIVERY_REPOSITORY,
  type EmailDeliveryRepositoryPort,
} from '../ports/email-delivery.repository.port.js';
import {
  EMAIL_SENDER,
  type EmailSenderPort,
} from '../ports/email-sender.port.js';
import { parseVerificationCodeIssuedPayload } from '../verification-code-issued.parser.js';
import { renderVerificationEmail } from '../verification-email.template.js';

/**
 * The consumer-side business rule for `identity.verification-code.issued`.
 *
 * It sends before recording anything as handled: the consumer's claim is
 * released only after both the SMTP side effect and its local bookkeeping are
 * done. A crash between them redelivers the event and risks a duplicate email,
 * which is the deliberate trade in ADR-0003.
 */
@Injectable()
export class HandleVerificationCodeIssuedUseCase implements EventHandlerPort {
  private readonly logger = new Logger(
    HandleVerificationCodeIssuedUseCase.name,
  );

  constructor(
    @Inject(EMAIL_SENDER) private readonly emails: EmailSenderPort,
    @Inject(EMAIL_DELIVERY_REPOSITORY)
    private readonly deliveries: EmailDeliveryRepositoryPort,
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

    // A dead code is worse than silence: the user acts on it, the API rejects
    // it, and the channel loses credibility. Check at handling time, not at
    // publish time, because the queue may have waited (ADR-0003).
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
      // Transient by default: the consumer releases the claim and retries.
      throw error;
    }

    // Taken after sendMail resolves, i.e. after the SMTP server accepted the
    // message. This is the end of BR-03's measurement.
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
