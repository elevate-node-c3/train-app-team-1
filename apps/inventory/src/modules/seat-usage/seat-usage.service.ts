import { Injectable } from '@nestjs/common';
import type { TripSeatUsage } from '@app/contracts';

/** No seat tables yet; report zero sold and held counts for every trip. */
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
