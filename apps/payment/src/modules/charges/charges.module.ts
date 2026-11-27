import { Module } from '@nestjs/common';
import {
  TICKET_CANCELLED_EVENT_TYPE,
  TICKET_CANCELLED_VERSION,
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

import { CardsModule } from '../cards/cards.module.js';
import { TicketCancelledConsumer } from './consumers/ticket-cancelled.consumer.js';
import { PaymentDoubleService } from './services/payment-double.service.js';
import { PaymentIntentService } from './services/payment-intent.service.js';
import { PaymentGrpcController } from './payment.grpc.controller.js';
import { ChargesPersistenceModule } from './charges-persistence.module.js';
import { PaymentRecoveryWorker } from './payment-recovery.worker.js';
import {
  PAYMENT_TICKET_CANCELLED_QUEUE,
  TicketCancelledTopologyService,
} from './ticket-cancelled.topology.js';

/** One queue per event type; parseEventEnvelope rejects other types. */
export function createTicketCancelledSubscriptions(
  handler: EventHandlerPort,
): EventSubscription[] {
  return [
    {
      eventType: TICKET_CANCELLED_EVENT_TYPE,
      version: TICKET_CANCELLED_VERSION,
      queueName: PAYMENT_TICKET_CANCELLED_QUEUE,
      handler,
    },
  ];
}

/** Owns charges and their refunds, including async ticket cancellation. */
@Module({
  imports: [MessagingModule, CardsModule, ChargesPersistenceModule],
  controllers: [PaymentGrpcController],
  providers: [
    PaymentDoubleService,
    PaymentIntentService,
    PaymentRecoveryWorker,
    TicketCancelledTopologyService,
    TicketCancelledConsumer,
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
  exports: [TicketCancelledTopologyService, TicketCancelledConsumer],
})
export class ChargesModule {}
