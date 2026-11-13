import { Module } from '@nestjs/common';
import {
  TRIP_PUBLISHED_EVENT_TYPE,
  TRIP_PUBLISHED_VERSION,
  TRIP_WITHDRAWN_EVENT_TYPE,
  TRIP_WITHDRAWN_VERSION,
} from '@app/contracts';
import { MessagingModule, OutboxModule } from '@app/messaging';
import { EventConsumerService } from '@app/messaging/consumer/event-consumer.service.js';
import { EventFailureRouter } from '@app/messaging/consumer/event-failure-router.js';
import type { EventHandlerPort } from '@app/messaging/consumer/event-handler.port.js';
import {
  EVENT_SUBSCRIPTIONS,
  type EventSubscription,
} from '@app/messaging/consumer/event-subscription.js';
import { MessageRepublisher } from '@app/messaging/consumer/message-republisher.js';
import { PROCESSED_EVENT_STORE } from '@app/messaging/consumer/processed-event.port.js';
import { TypeOrmProcessedEventStore } from '@app/messaging/consumer/typeorm-processed-event.store.js';

import { SeatsModule } from '../seats/seats.module.js';
import { TripLifecycleConsumer } from './trip-lifecycle.consumer.js';
import {
  INVENTORY_TRIP_PUBLISHED_QUEUE,
  INVENTORY_TRIP_WITHDRAWN_QUEUE,
  TripLifecycleTopologyService,
} from './trip-lifecycle.topology.js';

/** One queue per event type: see trip-lifecycle.topology.ts for why. */
export function createTripLifecycleSubscriptions(
  handler: EventHandlerPort,
): EventSubscription[] {
  return [
    {
      eventType: TRIP_PUBLISHED_EVENT_TYPE,
      version: TRIP_PUBLISHED_VERSION,
      queueName: INVENTORY_TRIP_PUBLISHED_QUEUE,
      handler,
    },
    {
      eventType: TRIP_WITHDRAWN_EVENT_TYPE,
      version: TRIP_WITHDRAWN_VERSION,
      queueName: INVENTORY_TRIP_WITHDRAWN_QUEUE,
      handler,
    },
  ];
}

/** Turns published trips into committed seats and closes withdrawn ones. */
@Module({
  imports: [MessagingModule, OutboxModule, SeatsModule],
  providers: [
    TripLifecycleTopologyService,
    TripLifecycleConsumer,
    TypeOrmProcessedEventStore,
    {
      provide: PROCESSED_EVENT_STORE,
      useExisting: TypeOrmProcessedEventStore,
    },
    {
      provide: EVENT_SUBSCRIPTIONS,
      useFactory: createTripLifecycleSubscriptions,
      inject: [TripLifecycleConsumer],
    },
    MessageRepublisher,
    EventFailureRouter,
    EventConsumerService,
  ],
  exports: [TripLifecycleTopologyService],
})
export class TripLifecycleModule {}
