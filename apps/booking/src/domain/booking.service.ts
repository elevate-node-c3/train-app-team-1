import { Injectable } from '@nestjs/common';
import { BookingRepository } from '../persistence/booking.repository.js';

@Injectable()
export class BookingService {
  constructor(private readonly repository: BookingRepository) {}

  getInfo(): { service: string; status: string } {
    return {
      service: 'booking',
      status: 'operational',
    };
  }
}
