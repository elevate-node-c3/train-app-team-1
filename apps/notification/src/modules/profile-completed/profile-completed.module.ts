import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  PROFILE_COMPLETED_EVENT_TYPE,
  PROFILE_COMPLETED_VERSION,
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
import type { EventHandlerPort } from '@app/messaging/consumer/event-handler.port.js';
import { ProfileCompletedConsumer } from './profile-completed.consumer.js';
import { TravellerProfileRepository } from './traveller-profile.repository.js';
import { TravellerProfileEntity } from './entities/traveller-profile.entity.js';

export const PROFILE_COMPLETED_QUEUE = 'notification.profile-completed';

export function createProfileCompletedSubscriptions(
  handler: EventHandlerPort,
): EventSubscription[] {
  return [
    {
      eventType: PROFILE_COMPLETED_EVENT_TYPE,
      version: PROFILE_COMPLETED_VERSION,
      queueName: PROFILE_COMPLETED_QUEUE,
      handler,
    },
  ];
}

@Module({
  imports: [
    MessagingModule,
    TypeOrmModule.forFeature([TravellerProfileEntity]),
  ],
  providers: [
    ProfileCompletedConsumer,
    TravellerProfileRepository,
    TypeOrmProcessedEventStore,
    {
      provide: PROCESSED_EVENT_STORE,
      useExisting: TypeOrmProcessedEventStore,
    },
    {
      provide: EVENT_SUBSCRIPTIONS,
      useFactory: createProfileCompletedSubscriptions,
      inject: [ProfileCompletedConsumer],
    },
    MessageRepublisher,
    EventFailureRouter,
    EventConsumerService,
  ],
  exports: [ProfileCompletedConsumer],
})
export class ProfileCompletedModule {}
