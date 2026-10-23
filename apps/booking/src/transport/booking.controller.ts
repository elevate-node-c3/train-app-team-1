import { Controller, Get } from '@nestjs/common';
import { BookingService } from '../domain/booking.service.js';

@Controller('booking')
export class BookingController {
  constructor(private readonly bookingService: BookingService) {}

  @Get()
  getInfo(): { service: string; status: string } {
    return this.bookingService.getInfo();
  }
}
