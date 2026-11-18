import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  getInventoryProtoPath,
  getIdentityProtoPath,
  INVENTORY_PACKAGE_NAME,
  IDENTITY_PACKAGE_NAME,
} from '@app/contracts';
import {
  EVENT_SUBSCRIPTIONS,
  PROCESSED_EVENT_STORE,
  EventConsumerService,
  EventFailureRouter,
  MessageRepublisher,
  MessagingModule,
  TypeOrmProcessedEventStore,
} from '@app/messaging';
import { BookingDraftEntity } from './entities/booking-draft.entity.js';
import {
  BookingDraftService,
  INVENTORY_GRPC_CLIENT,
  IDENTITY_GRPC_CLIENT,
} from './booking-draft.service.js';
import { BookingDraftController } from './booking-draft.controller.js';
import { BookingDraftStore } from './booking-draft.store.js';
import { BookingIngressGuard } from './booking-ingress.guard.js';
import {
  BookingHoldLifecycleConsumer,
  createHoldLifecycleSubscriptions,
} from './hold-lifecycle.consumer.js';

export const INVENTORY_GRPC_LOADER_OPTIONS = {
  enums: String,
  arrays: true,
  defaults: true,
} as const;

export function inventoryGrpcUrl(): string {
  const url = process.env.INVENTORY_GRPC_URL;
  return url && url.trim().length > 0 ? url.trim() : 'inventory:50051';
}

@Module({
  imports: [
    TypeOrmModule.forFeature([BookingDraftEntity]),
    MessagingModule,
    ClientsModule.registerAsync([
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
      {
        name: IDENTITY_GRPC_CLIENT,
        useFactory: () => ({
          transport: Transport.GRPC,
          options: {
            package: IDENTITY_PACKAGE_NAME,
            protoPath: getIdentityProtoPath(),
            url: process.env.IDENTITY_GRPC_URL?.trim() || 'identity:50051',
            loader: INVENTORY_GRPC_LOADER_OPTIONS,
          },
        }),
      },
    ]),
  ],
  controllers: [BookingDraftController],
  providers: [
    BookingDraftService,
    BookingDraftStore,
    BookingIngressGuard,
    BookingHoldLifecycleConsumer,
    TypeOrmProcessedEventStore,
    { provide: PROCESSED_EVENT_STORE, useExisting: TypeOrmProcessedEventStore },
    {
      provide: EVENT_SUBSCRIPTIONS,
      useFactory: createHoldLifecycleSubscriptions,
      inject: [BookingHoldLifecycleConsumer],
    },
    MessageRepublisher,
    EventFailureRouter,
    EventConsumerService,
  ],
  exports: [BookingDraftService, BookingDraftStore],
})
export class BookingDraftModule {}
