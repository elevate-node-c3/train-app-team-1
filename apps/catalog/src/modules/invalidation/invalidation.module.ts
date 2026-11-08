import { Module } from '@nestjs/common';
import {
  FARE_CHANGED_EVENT_TYPE,
  FARE_CHANGED_VERSION,
  SEAT_AVAILABILITY_CHANGED_EVENT_TYPE,
  SEAT_AVAILABILITY_CHANGED_VERSION,
  STATION_CHANGED_EVENT_TYPE,
  STATION_CHANGED_VERSION,
  TIMETABLE_PUBLISHED_EVENT_TYPE,
  TIMETABLE_PUBLISHED_VERSION,
} from '@app/contracts';
import { MessagingModule } from '@app/messaging';
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

import { CatalogCacheModule } from '../cache/catalog-cache.module.js';
import { StationsModule } from '../stations/stations.module.js';
import { TripsModule } from '../trips/trips.module.js';
import { CacheInvalidationConsumer } from './cache-invalidation.consumer.js';

export const CATALOG_INVALIDATION_QUEUE = 'catalog.invalidation';

export function createCatalogInvalidationSubscriptions(
  handler: EventHandlerPort,
): EventSubscription[] {
  return [
    {
      eventType: FARE_CHANGED_EVENT_TYPE,
      version: FARE_CHANGED_VERSION,
      queueName: CATALOG_INVALIDATION_QUEUE,
      handler,
    },
    {
      eventType: TIMETABLE_PUBLISHED_EVENT_TYPE,
      version: TIMETABLE_PUBLISHED_VERSION,
      queueName: CATALOG_INVALIDATION_QUEUE,
      handler,
    },
    {
      eventType: STATION_CHANGED_EVENT_TYPE,
      version: STATION_CHANGED_VERSION,
      queueName: CATALOG_INVALIDATION_QUEUE,
      handler,
    },
    {
      eventType: SEAT_AVAILABILITY_CHANGED_EVENT_TYPE,
      version: SEAT_AVAILABILITY_CHANGED_VERSION,
      queueName: CATALOG_INVALIDATION_QUEUE,
      handler,
    },
  ];
}

@Module({
  imports: [
    MessagingModule,
    CatalogCacheModule,
    StationsModule,
    TripsModule,
  ],
  providers: [
    CacheInvalidationConsumer,
    TypeOrmProcessedEventStore,
    {
      provide: PROCESSED_EVENT_STORE,
      useExisting: TypeOrmProcessedEventStore,
    },
    {
      provide: EVENT_SUBSCRIPTIONS,
      useFactory: createCatalogInvalidationSubscriptions,
      inject: [CacheInvalidationConsumer],
    },
    MessageRepublisher,
    EventFailureRouter,
    EventConsumerService,
  ],
  exports: [CacheInvalidationConsumer],
})
export class InvalidationModule {}
