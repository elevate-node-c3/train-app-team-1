import { Module } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { BookingController } from './booking.controller.js';
import { BookingRequestGuard } from './booking-request.guard.js';
import {
  BOOKING_CLIENT,
  BookingHttpService,
  BookingService,
} from './booking.service.js';

export const BOOKING_BASE_URL = 'BOOKING_BASE_URL';

export function bookingServiceUrl(): string {
  const url = process.env.BOOKING_SERVICE_URL || process.env.BOOKING_URL;
  return url && url.trim().length > 0 ? url.trim() : 'http://booking:3000';
}

@Module({
  controllers: [BookingController],
  providers: [
    BookingService,
    BookingRequestGuard,
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
