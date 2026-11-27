import { Injectable, Logger } from '@nestjs/common';
import { maskEmail } from '@app/common/logging/pii-redactor.js';
import type { EventEnvelope } from '@app/contracts';
import type {
  EventHandlerPort,
  EventHandlingResult,
} from '@app/messaging/consumer/event-handler.port.js';

import { NotificationRecipientService } from '../notification-recipient.service.js';
import { NodemailerEmailSender } from '../../verification-emails/email-sender.js';
import { parseTicketCancelledEvent } from '../booking-outcomes.parser.js';
import { renderTicketCancelledEmail } from '../booking-outcome.template.js';

/** A ticket was cancelled and refunded; tell the traveller the seat is freed. */
@Injectable()
export class TicketCancelledConsumer implements EventHandlerPort {
  private readonly logger = new Logger(TicketCancelledConsumer.name);

  constructor(
    private readonly recipients: NotificationRecipientService,
    private readonly emails: NodemailerEmailSender,
  ) {}

  async handle(envelope: EventEnvelope): Promise<EventHandlingResult> {
    const payload = parseTicketCancelledEvent(envelope);
    const recipient = await this.recipients.recipientFor(payload.accountId);

    const content = renderTicketCancelledEmail(payload, recipient.language);
    await this.emails.send({
      to: recipient.email,
      subject: content.subject,
      text: content.text,
      html: content.html,
    });

    this.logger.log(
      `Cancellation email sent to ${maskEmail(recipient.email)} for booking ${payload.bookingReference} (event ${envelope.id})`,
    );
    return { status: 'handled' };
  }
}
