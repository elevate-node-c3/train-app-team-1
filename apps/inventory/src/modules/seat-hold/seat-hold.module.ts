import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  TICKET_CANCELLED_EVENT_TYPE,
  TICKET_CANCELLED_VERSION,
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
import { MigrationModule } from '@app/common';
import { SeatHoldGroupEntity } from './entities/seat-hold-group.entity.js';
import { SeatHoldOwnerGuardEntity } from './entities/seat-hold-owner-guard.entity.js';
import { SeatHoldPassengerEntity } from './entities/seat-hold-passenger.entity.js';
import { SeatHoldLegEntity } from './entities/seat-hold-leg.entity.js';
import { SeatHoldAssignmentEntity } from './entities/seat-hold-assignment.entity.js';
import { SeatHoldGrpcController } from './seat-hold.grpc.controller.js';
import { HoldCoreRepository } from './hold-core.repository.js';
import { HoldCoreService } from './services/hold-core.service.js';
import { HoldSettlementService } from './services/hold-settlement.service.js';
import { HoldExpiryWorker } from './hold-expiry.worker.js';
import { HoldCreationGuard, HoldServiceGuard } from './hold-access.guard.js';
import { SoldSeatReleaseService } from './services/sold-seat-release.service.js';
import { TicketCancelledConsumer } from './consumers/ticket-cancelled.consumer.js';
import {
  INVENTORY_TICKET_CANCELLED_QUEUE,
  TicketCancelledTopologyService,
} from './ticket-cancelled.topology.js';
import { SeatsModule } from '../seats/seats.module.js';

export function createTicketCancelledSubscriptions(
  handler: EventHandlerPort,
): EventSubscription[] {
  return [
    {
      eventType: TICKET_CANCELLED_EVENT_TYPE,
      version: TICKET_CANCELLED_VERSION,
      queueName: INVENTORY_TICKET_CANCELLED_QUEUE,
      handler,
    },
  ];
}

@Module({
  imports: [
    TypeOrmModule.forFeature([
      SeatHoldGroupEntity,
      SeatHoldOwnerGuardEntity,
      SeatHoldPassengerEntity,
      SeatHoldLegEntity,
      SeatHoldAssignmentEntity,
    ]),
    MessagingModule,
    OutboxModule,
    MigrationModule,
    SeatsModule,
  ],
  controllers: [SeatHoldGrpcController],
  providers: [
    HoldCoreRepository,
    HoldCoreService,
    HoldSettlementService,
    HoldExpiryWorker,
    HoldCreationGuard,
    HoldServiceGuard,
    SoldSeatReleaseService,
    TicketCancelledConsumer,
    TicketCancelledTopologyService,
    TypeOrmProcessedEventStore,
    {
      provide: PROCESSED_EVENT_STORE,
      useExisting: TypeOrmProcessedEventStore,
    },
    {
      provide: EVENT_SUBSCRIPTIONS,
      useFactory: createTicketCancelledSubscriptions,
      inject: [TicketCancelledConsumer],
    },
    MessageRepublisher,
    EventFailureRouter,
    EventConsumerService,
  ],
  exports: [
    HoldCoreService,
    HoldSettlementService,
    TicketCancelledTopologyService,
    TicketCancelledConsumer,
  ],
})
export class SeatHoldModule {}
