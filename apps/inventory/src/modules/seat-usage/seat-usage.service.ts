import { Injectable } from '@nestjs/common';
import type { TripSeatUsage } from '@app/contracts';

import { SeatUsageRepository } from '../seats/seat-usage.repository.js';

/** Answers catalog's republish-safety question from the real seat tables. */
@Injectable()
export class SeatUsageService {
  constructor(private readonly repository: SeatUsageRepository) {}

  async seatUsageForTrips(tripIds: string[]): Promise<TripSeatUsage[]> {
    return this.repository.usageFor(tripIds);
  }
}
