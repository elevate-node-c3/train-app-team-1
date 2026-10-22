import { Controller, Get } from '@nestjs/common';
import { BookingsService } from './bookings.service.js';

@Controller()
export class BookingsController {
  constructor(private readonly bookingsService: BookingsService) {}

  @Get()
  getHello(): string {
    return this.bookingsService.getHello();
  }
}
