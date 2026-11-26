import { Injectable, Logger } from '@nestjs/common';
import QRCode from 'qrcode';
import { maskEmail } from '@app/common/logging/pii-redactor.js';
import type { EventEnvelope } from '@app/contracts';
import type {
  EventHandlerPort,
  EventHandlingResult,
} from '@app/messaging/consumer/event-handler.port.js';

import { NotificationRecipientService } from '../booking-outcomes/notification-recipient.service.js';
import { NodemailerEmailSender } from '../verification-emails/email-sender.js';
import { parseBookingConfirmedEvent } from './booking-confirmed.parser.js';
import {
  qrContentId,
  renderBookingConfirmedEmail,
} from './booking-confirmed.template.js';

/**
 * `booking.confirmed` becomes one email carrying every ticket (BR-53).
 *
 * Booking's event already carries each ticket as issued, with its signed QR,
 * so notification asks booking for nothing and never reads its database. The
 * QR images are drawn here from booking's signed payload; drawing a picture of
 * a payload signs nothing, so the signature stays booking's alone.
 *
 * Exactly once per event: the consumer claims the event id in
 * `processed_event` before this runs, so a redelivery is acknowledged without
 * a second email. If notification is down, the event waits in its durable
 * queue and is retried indefinitely; the booking is confirmed regardless
 * (BR-54).
 */
@Injectable()
export class BookingConfirmedConsumer implements EventHandlerPort {
  private readonly logger = new Logger(BookingConfirmedConsumer.name);

  constructor(
    private readonly recipients: NotificationRecipientService,
    private readonly emails: NodemailerEmailSender,
  ) {}

  async handle(envelope: EventEnvelope): Promise<EventHandlingResult> {
    const payload = parseBookingConfirmedEvent(envelope);
    const recipient = await this.recipients.recipientFor(payload.accountId);

    const attachments = await Promise.all(
      payload.tickets.map(async (ticket) => ({
        filename: `${ticket.ticketNumber}.png`,
        content: await QRCode.toBuffer(ticket.qr, {
          errorCorrectionLevel: 'M',
          margin: 1,
          width: 360,
        }),
        contentType: 'image/png',
        cid: qrContentId(ticket.ticketNumber),
      })),
    );
    const content = renderBookingConfirmedEmail(payload, recipient.language);

    await this.emails.send({
      to: recipient.email,
      subject: content.subject,
      text: content.text,
      html: content.html,
      attachments,
    });

    this.logger.log(
      `Confirmation email with ${payload.tickets.length} ticket(s) sent to ${maskEmail(recipient.email)} for booking ${payload.bookingReference} (event ${envelope.id})`,
    );
    return { status: 'handled' };
  }
}
