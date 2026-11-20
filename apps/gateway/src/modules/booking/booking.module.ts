import { Module } from '@nestjs/common';
import {
  ClientsModule,
  Transport,
  type ClientGrpc,
} from '@nestjs/microservices';
import { ClsService } from 'nestjs-cls';
import {
  BOOKING_PACKAGE_NAME,
  BOOKING_SERVICE_NAME,
  getBookingProtoPath,
} from '@app/contracts';
import { BookingController } from './booking.controller.js';
import { BookingGrpcClientService } from './booking.grpc.client.js';
import { BookingRequestGuard } from './booking-request.guard.js';
import {
  BOOKING_CLIENT,
  BookingHttpService,
  BookingService,
} from './booking.service.js';
import {
  BOOKING_GRPC_CLIENT,
  type BookingGrpcClient,
} from './booking.types.js';

export const BOOKING_BASE_URL = 'BOOKING_BASE_URL';

const BOOKING_GRPC = 'BOOKING_GRPC';

export function bookingServiceUrl(): string {
  const url = process.env.BOOKING_SERVICE_URL || process.env.BOOKING_URL;
  return url && url.trim().length > 0 ? url.trim() : 'http://booking:3000';
}

/** Addresses stay in the environment; compose sets them per service. */
export function bookingGrpcUrl(): string {
  return process.env.BOOKING_GRPC_URL?.trim() || 'booking:50051';
}

/**
 * ClientsModule owns the connection lifecycle; resolve its proxy once so the
 * client service receives a ready stub, as the catalog module does.
 */
@Module({
  imports: [
    ClientsModule.registerAsync([
      {
        name: BOOKING_GRPC,
        useFactory: () => ({
          transport: Transport.GRPC,
          options: {
            package: BOOKING_PACKAGE_NAME,
            protoPath: getBookingProtoPath(),
            url: bookingGrpcUrl(),
            loader: { enums: String, arrays: true },
          },
        }),
      },
    ]),
  ],
  controllers: [BookingController],
  providers: [
    BookingService,
    BookingRequestGuard,
    BookingGrpcClientService,
    {
      provide: BOOKING_GRPC_CLIENT,
      inject: [BOOKING_GRPC],
      useFactory: (client: ClientGrpc) =>
        client.getService<BookingGrpcClient>(BOOKING_SERVICE_NAME),
    },
    {
      provide: BOOKING_BASE_URL,
      useFactory: () => bookingServiceUrl(),
    },
    {
      provide: BOOKING_CLIENT,
      inject: [BOOKING_BASE_URL, ClsService],
      useFactory: (baseUrl: string, cls: ClsService) =>
        new BookingHttpService(baseUrl, cls),
    },
  ],
  exports: [BookingService, BOOKING_CLIENT],
})
export class BookingModule {}
