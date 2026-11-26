import { Module } from '@nestjs/common';
import {
  ClientsModule,
  Transport,
  type ClientGrpc,
} from '@nestjs/microservices';
import {
  BOOKING_PACKAGE_NAME,
  TICKET_SERVICE_NAME,
  getBookingProtoPath,
} from '@app/contracts';

import { downstreamGrpcUrlsFromEnv } from '../../config/grpc-settings.js';
import { TicketsController } from './tickets.controller.js';
import { TicketsGrpcClientService } from './tickets.grpc.client.js';
import {
  TICKETS_GRPC_CLIENT,
  type TicketsGrpcClient,
} from './tickets.types.js';

const TICKETS_BOOKING_GRPC = 'TICKETS_BOOKING_GRPC';

/** Booking's TicketService, served beside BookingService from booking.proto. */
@Module({
  imports: [
    ClientsModule.registerAsync([
      {
        name: TICKETS_BOOKING_GRPC,
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
  controllers: [TicketsController],
  providers: [
    TicketsGrpcClientService,
    {
      provide: TICKETS_GRPC_CLIENT,
      inject: [TICKETS_BOOKING_GRPC],
      useFactory: (client: ClientGrpc) =>
        client.getService<TicketsGrpcClient>(TICKET_SERVICE_NAME),
    },
  ],
})
export class TicketsModule {}
