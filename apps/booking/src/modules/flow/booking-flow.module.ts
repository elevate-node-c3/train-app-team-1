import { Module } from '@nestjs/common';
import {
  ClientsModule,
  Transport,
  type ClientGrpc,
} from '@nestjs/microservices';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  CATALOG_PACKAGE_NAME,
  CATALOG_SERVICE_NAME,
  INVENTORY_PACKAGE_NAME,
  INVENTORY_SERVICE_NAME,
  PAYMENT_PACKAGE_NAME,
  PAYMENT_SERVICE_NAME,
  getCatalogProtoPath,
  getInventoryProtoPath,
  getPaymentProtoPath,
} from '@app/contracts';
import {
  EVENT_SUBSCRIPTIONS,
  EventConsumerService,
  EventFailureRouter,
  MessageRepublisher,
  MessagingModule,
  OutboxModule,
  PROCESSED_EVENT_STORE,
  TypeOrmProcessedEventStore,
} from '@app/messaging';

import {
  INVENTORY_GRPC_LOADER_OPTIONS,
  inventoryGrpcUrl,
} from '../draft/booking-draft.module.js';
import { BookingDraftModule } from '../draft/booking-draft.module.js';
import { BookingDraftEntity } from '../draft/entities/booking-draft.entity.js';
import { TicketEntity } from './entities/ticket.entity.js';
import { BookingFlowGrpcController } from './booking-flow.grpc.controller.js';
import { BookingFlowRepository } from './booking-flow.repository.js';
import { BookingConfirmationService } from './services/booking-confirmation.service.js';
import { TicketCancellationRepository } from './services/ticket-cancellation.repository.js';
import { TicketCancellationService } from './services/ticket-cancellation.service.js';
import { TicketIssuerService } from './services/ticket-issuer.service.js';
import { TicketCancellationGrpcController } from './ticket-cancellation.grpc.controller.js';
import { TicketsModule } from '../tickets/tickets.module.js';
import {
  PaymentSucceededConsumer,
  createPaymentSucceededSubscriptions,
} from './payment-succeeded.consumer.js';
import { BookingFlowService } from './services/booking-flow.service.js';
import { BookingFlowWorker } from './booking-flow.worker.js';
import {
  CATALOG_FLOW_CLIENT,
  INVENTORY_FLOW_CLIENT,
  PAYMENT_FLOW_CLIENT,
} from './flow-clients.types.js';
import { FlowGrpcClientsService } from './services/flow-grpc-clients.service.js';

const CATALOG_GRPC_CLIENT = Symbol('CATALOG_GRPC_CLIENT');
const PAYMENT_GRPC_CLIENT = Symbol('PAYMENT_GRPC_CLIENT');
const INVENTORY_GRPC_CLIENT = Symbol('INVENTORY_GRPC_CLIENT_FLOW');

/** Addresses stay in the environment; compose sets them per service. */
export function catalogGrpcUrl(): string {
  return process.env.CATALOG_GRPC_URL?.trim() || 'catalog:50051';
}

export function paymentGrpcUrl(): string {
  return process.env.PAYMENT_GRPC_URL?.trim() || 'payment:50051';
}

/**
 * Checkout: quote, hold, pay, and -- once payment has settled -- the
 * confirmation saga that sells inventory's hold or refunds the charge.
 * Identity is not reached from here -- BookingDraftModule owns that client
 * and the hold's own create/release/extend lifecycle.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([BookingDraftEntity, TicketEntity]),
    MessagingModule,
    OutboxModule,
    BookingDraftModule,
    // TA-108: the issuer signs each ticket's QR with the tickets' signer.
    TicketsModule,
    ClientsModule.registerAsync([
      {
        name: CATALOG_GRPC_CLIENT,
        useFactory: () => ({
          transport: Transport.GRPC,
          options: {
            package: CATALOG_PACKAGE_NAME,
            protoPath: getCatalogProtoPath(),
            url: catalogGrpcUrl(),
          },
        }),
      },
      {
        name: PAYMENT_GRPC_CLIENT,
        useFactory: () => ({
          transport: Transport.GRPC,
          options: {
            package: PAYMENT_PACKAGE_NAME,
            protoPath: getPaymentProtoPath(),
            url: paymentGrpcUrl(),
          },
        }),
      },
      {
        name: INVENTORY_GRPC_CLIENT,
        useFactory: () => ({
          transport: Transport.GRPC,
          options: {
            package: INVENTORY_PACKAGE_NAME,
            protoPath: getInventoryProtoPath(),
            url: inventoryGrpcUrl(),
            loader: INVENTORY_GRPC_LOADER_OPTIONS,
          },
        }),
      },
    ]),
  ],
  controllers: [BookingFlowGrpcController, TicketCancellationGrpcController],
  providers: [
    BookingFlowRepository,
    BookingFlowService,
    BookingConfirmationService,
    TicketCancellationRepository,
    TicketCancellationService,
    TicketIssuerService,
    FlowGrpcClientsService,
    BookingFlowWorker,
    PaymentSucceededConsumer,
    TypeOrmProcessedEventStore,
    { provide: PROCESSED_EVENT_STORE, useExisting: TypeOrmProcessedEventStore },
    {
      provide: EVENT_SUBSCRIPTIONS,
      useFactory: createPaymentSucceededSubscriptions,
      inject: [PaymentSucceededConsumer],
    },
    MessageRepublisher,
    EventFailureRouter,
    EventConsumerService,
    {
      provide: CATALOG_FLOW_CLIENT,
      inject: [CATALOG_GRPC_CLIENT],
      useFactory: (client: ClientGrpc) =>
        client.getService(CATALOG_SERVICE_NAME),
    },
    {
      provide: PAYMENT_FLOW_CLIENT,
      inject: [PAYMENT_GRPC_CLIENT],
      useFactory: (client: ClientGrpc) =>
        client.getService(PAYMENT_SERVICE_NAME),
    },
    {
      provide: INVENTORY_FLOW_CLIENT,
      inject: [INVENTORY_GRPC_CLIENT],
      useFactory: (client: ClientGrpc) =>
        client.getService(INVENTORY_SERVICE_NAME),
    },
  ],
  exports: [BookingFlowService, BookingFlowRepository],
})
export class BookingFlowModule {}
