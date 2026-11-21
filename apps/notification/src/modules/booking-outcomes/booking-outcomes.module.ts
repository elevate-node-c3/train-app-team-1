import { Module } from '@nestjs/common';
import {
  BOOKING_REFUNDED_EVENT_TYPE,
  BOOKING_REFUNDED_VERSION,
  BOOKING_SEATS_CHANGED_EVENT_TYPE,
  BOOKING_SEATS_CHANGED_VERSION,
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

import { ProfileCompletedModule } from '../profile-completed/profile-completed.module.js';
import { NodemailerEmailSender } from '../verification-emails/email-sender.js';
import { BookingRefundedConsumer } from './consumers/booking-refunded.consumer.js';
import { SeatsChangedConsumer } from './consumers/seats-changed.consumer.js';

export const SEATS_CHANGED_QUEUE = 'notification.booking.seats-changed';
export const BOOKING_REFUNDED_QUEUE = 'notification.booking.refunded';

export function createBookingOutcomeSubscriptions(
  seatsChanged: SeatsChangedConsumer,
  refunded: BookingRefundedConsumer,
): EventSubscription[] {
  return [
    {
      eventType: BOOKING_SEATS_CHANGED_EVENT_TYPE,
      version: BOOKING_SEATS_CHANGED_VERSION,
      queueName: SEATS_CHANGED_QUEUE,
      handler: seatsChanged,
    },
    {
      eventType: BOOKING_REFUNDED_EVENT_TYPE,
      version: BOOKING_REFUNDED_VERSION,
      queueName: BOOKING_REFUNDED_QUEUE,
      handler: refunded,
    },
  ];
}

/**
 * Two of TA-107's three events reach notification here (`booking.confirmed`'s
 * email is TA-108's, since it carries the tickets and the QR). Reuses
 * `NodemailerEmailSender` and the traveller directory `profile-completed`
 * already built; adds no new email-delivery log since this isn't a
 * verification code.
 */
@Module({
  imports: [MessagingModule, ProfileCompletedModule],
  providers: [
    SeatsChangedConsumer,
    BookingRefundedConsumer,
    NodemailerEmailSender,
    TypeOrmProcessedEventStore,
    {
      provide: PROCESSED_EVENT_STORE,
      useExisting: TypeOrmProcessedEventStore,
    },
    {
      provide: EVENT_SUBSCRIPTIONS,
      useFactory: createBookingOutcomeSubscriptions,
      inject: [SeatsChangedConsumer, BookingRefundedConsumer],
    },
    MessageRepublisher,
    EventFailureRouter,
    EventConsumerService,
  ],
})
export class BookingOutcomesModule {}
