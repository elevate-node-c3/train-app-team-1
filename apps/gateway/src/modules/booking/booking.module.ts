import { Module } from '@nestjs/common';
import {
  ClientsModule,
  Transport,
  type ClientGrpc,
} from '@nestjs/microservices';
import {
  BOOKING_PACKAGE_NAME,
  BOOKING_SERVICE_NAME,
  getBookingProtoPath,
} from '@app/contracts';

import { downstreamGrpcUrlsFromEnv } from '../../config/grpc-settings.js';
import { BookingController } from './booking.controller.js';
import { BookingGrpcClientService } from './booking.grpc.client.js';
import { BookingRequestGuard } from './booking-request.guard.js';
import { BookingService } from './booking.service.js';
import {
  BOOKING_GRPC_CLIENT,
  type BookingGrpcClient,
} from './booking.types.js';

const BOOKING_GRPC = 'BOOKING_GRPC';

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
            url: downstreamGrpcUrlsFromEnv().booking,
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
  ],
  exports: [BookingService],
})
export class BookingModule {}
