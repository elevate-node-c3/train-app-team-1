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
  PAYMENT_PACKAGE_NAME,
  PAYMENT_SERVICE_NAME,
  getCatalogProtoPath,
  getPaymentProtoPath,
} from '@app/contracts';
import { MessagingModule, OutboxModule } from '@app/messaging';

import { BookingDraftModule } from '../draft/booking-draft.module.js';
import { BookingDraftEntity } from '../draft/entities/booking-draft.entity.js';
import { BookingFlowGrpcController } from './booking-flow.grpc.controller.js';
import { BookingFlowRepository } from './booking-flow.repository.js';
import { BookingFlowService } from './services/booking-flow.service.js';
import { BookingFlowWorker } from './booking-flow.worker.js';
import {
  CATALOG_FLOW_CLIENT,
  PAYMENT_FLOW_CLIENT,
} from './flow-clients.types.js';
import { FlowGrpcClientsService } from './services/flow-grpc-clients.service.js';

const CATALOG_GRPC_CLIENT = Symbol('CATALOG_GRPC_CLIENT');
const PAYMENT_GRPC_CLIENT = Symbol('PAYMENT_GRPC_CLIENT');

/** Addresses stay in the environment; compose sets them per service. */
export function catalogGrpcUrl(): string {
  return process.env.CATALOG_GRPC_URL?.trim() || 'catalog:50051';
}

export function paymentGrpcUrl(): string {
  return process.env.PAYMENT_GRPC_URL?.trim() || 'payment:50051';
}

/**
 * Checkout: quote, hold, pay. Inventory and identity are not reached from
 * here -- BookingDraftModule owns those clients and the hold itself.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([BookingDraftEntity]),
    MessagingModule,
    OutboxModule,
    BookingDraftModule,
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
    ]),
  ],
  controllers: [BookingFlowGrpcController],
  providers: [
    BookingFlowRepository,
    BookingFlowService,
    FlowGrpcClientsService,
    BookingFlowWorker,
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
  ],
  exports: [BookingFlowService],
})
export class BookingFlowModule {}
