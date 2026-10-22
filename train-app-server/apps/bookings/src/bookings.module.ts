import { Module } from '@nestjs/common';
import { BookingsController } from './bookings.controller.js';
import { BookingsService } from './bookings.service.js';

@Module({
  imports: [],
  controllers: [BookingsController],
  providers: [BookingsService],
})
export class BookingsModule {}
