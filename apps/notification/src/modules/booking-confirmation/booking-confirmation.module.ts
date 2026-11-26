import { Module } from '@nestjs/common';
import {
  BOOKING_CONFIRMED_EVENT_TYPE,
  BOOKING_CONFIRMED_VERSION,
} from '@app/contracts';
import {
  EVENT_SUBSCRIPTIONS,
  type EventSubscription,
} from '@app/messaging/consumer/event-subscription.js';
import { EventConsumerService } from '@app/messaging/consumer/event-consumer.service.js';
import { EventFailureRouter } from '@app/messaging/consumer/event-failure-router.js';
import { MessageRepublisher } from '@app/messaging/consumer/message-republisher.js';
import { PROCESSED_EVENT_STORE } from '@app/messaging/consumer/processed-event.port.js';
import { TypeOrmProcessedEventStore } from '@app/messaging/consumer/typeorm-processed-event.store.js';
import { MessagingModule } from '@app/messaging';

import { BookingOutcomesModule } from '../booking-outcomes/booking-outcomes.module.js';
import { NodemailerEmailSender } from '../verification-emails/email-sender.js';
import { BookingConfirmedConsumer } from './booking-confirmed.consumer.js';

export const BOOKING_CONFIRMED_QUEUE = 'notification.booking.confirmed';

/**
 * Retried indefinitely, like TA-107's booking outcomes: a confirmed booking's
 * tickets must reach the traveller however long notification was down.
 */
export function createBookingConfirmationSubscriptions(
  confirmed: BookingConfirmedConsumer,
): EventSubscription[] {
  return [
    {
      eventType: BOOKING_CONFIRMED_EVENT_TYPE,
      version: BOOKING_CONFIRMED_VERSION,
      queueName: BOOKING_CONFIRMED_QUEUE,
      handler: confirmed,
      retryIndefinitely: true,
    },
  ];
}

/** TA-108: the booking confirmation email, with every ticket and its QR. */
@Module({
  imports: [MessagingModule, BookingOutcomesModule],
  providers: [
    BookingConfirmedConsumer,
    NodemailerEmailSender,
    TypeOrmProcessedEventStore,
    {
      provide: PROCESSED_EVENT_STORE,
      useExisting: TypeOrmProcessedEventStore,
    },
    {
      provide: EVENT_SUBSCRIPTIONS,
      useFactory: createBookingConfirmationSubscriptions,
      inject: [BookingConfirmedConsumer],
    },
    MessageRepublisher,
    EventFailureRouter,
    EventConsumerService,
  ],
})
export class BookingConfirmationModule {}
