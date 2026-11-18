import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  getInventoryProtoPath,
  INVENTORY_PACKAGE_NAME,
} from '@app/contracts';
import { BookingDraftEntity } from './entities/booking-draft.entity.js';
import {
  BookingDraftService,
  INVENTORY_GRPC_CLIENT,
} from './booking-draft.service.js';
import { BookingDraftController } from './booking-draft.controller.js';

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
    ]),
  ],
  controllers: [BookingDraftController],
  providers: [BookingDraftService],
  exports: [BookingDraftService],
})
export class BookingDraftModule {}
