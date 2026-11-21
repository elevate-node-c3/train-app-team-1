import { Injectable, Logger } from '@nestjs/common';
import { maskEmail } from '@app/common/logging/pii-redactor.js';
import type { EventEnvelope } from '@app/contracts';
import type {
  EventHandlerPort,
  EventHandlingResult,
} from '@app/messaging/consumer/event-handler.port.js';
import { TravellerProfileRepository } from '../../profile-completed/traveller-profile.repository.js';
import { NodemailerEmailSender } from '../../verification-emails/email-sender.js';
import { parseBookingRefundedEvent } from '../booking-outcomes.parser.js';
import { renderBookingRefundedEmail } from '../booking-outcome.template.js';

/** No seat was left after a late payment; tell the traveller they were refunded in full. */
@Injectable()
export class BookingRefundedConsumer implements EventHandlerPort {
  private readonly logger = new Logger(BookingRefundedConsumer.name);

  constructor(
    private readonly travellers: TravellerProfileRepository,
    private readonly emails: NodemailerEmailSender,
  ) {}

  async handle(envelope: EventEnvelope): Promise<EventHandlingResult> {
    const payload = parseBookingRefundedEvent(envelope);
    const traveller = await this.travellers.findByAccountId(
      payload.accountId,
    );
    if (!traveller?.email) {
      this.logger.warn(
        `No address on file for account ${payload.accountId}; skipping (event ${envelope.id})`,
      );
      return { status: 'skipped', skipReason: 'no_email_on_file' };
    }

    const content = renderBookingRefundedEmail(payload);
    await this.emails.send({
      to: traveller.email,
      subject: content.subject,
      text: content.text,
      html: content.html,
    });

    this.logger.log(
      `Refund email sent to ${maskEmail(traveller.email)} for booking ${payload.bookingReference} (event ${envelope.id})`,
    );
    return { status: 'handled' };
  }
}
