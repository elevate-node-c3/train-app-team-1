import { Injectable } from '@nestjs/common';
import type { TripSeatUsage } from '@app/contracts';

/** No seat tables yet, so every trip reports zero sold/held -- an answer, not silence. */
@Injectable()
export class SeatUsageService {
  async seatUsageForTrips(tripIds: string[]): Promise<TripSeatUsage[]> {
    return tripIds.map((tripId) => ({
      tripId,
      soldCount: 0,
      heldCount: 0,
      stationIdsInUse: [],
    }));
  }
}
