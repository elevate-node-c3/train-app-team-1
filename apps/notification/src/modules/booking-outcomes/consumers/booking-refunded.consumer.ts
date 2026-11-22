import { Injectable, Logger } from '@nestjs/common';
import { maskEmail } from '@app/common/logging/pii-redactor.js';
import type { EventEnvelope } from '@app/contracts';
import type {
  EventHandlerPort,
  EventHandlingResult,
} from '@app/messaging/consumer/event-handler.port.js';
import { NotificationRecipientService } from '../notification-recipient.service.js';
import { NodemailerEmailSender } from '../../verification-emails/email-sender.js';
import { parseBookingRefundedEvent } from '../booking-outcomes.parser.js';
import { renderBookingRefundedEmail } from '../booking-outcome.template.js';

/** No seat was left after a late payment; tell the traveller they were refunded in full. */
@Injectable()
export class BookingRefundedConsumer implements EventHandlerPort {
  private readonly logger = new Logger(BookingRefundedConsumer.name);

  constructor(
    private readonly recipients: NotificationRecipientService,
    private readonly emails: NodemailerEmailSender,
  ) {}

  async handle(envelope: EventEnvelope): Promise<EventHandlingResult> {
    const payload = parseBookingRefundedEvent(envelope);
    const email = await this.recipients.emailFor(payload.accountId);

    const content = renderBookingRefundedEmail(payload);
    await this.emails.send({
      to: email,
      subject: content.subject,
      text: content.text,
      html: content.html,
    });

    this.logger.log(
      `Refund email sent to ${maskEmail(email)} for booking ${payload.bookingReference} (event ${envelope.id})`,
    );
    return { status: 'handled' };
  }
}
