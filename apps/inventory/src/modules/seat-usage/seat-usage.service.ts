import { Injectable } from '@nestjs/common';
import type { TripSeatUsage } from '@app/contracts';

/**
 * Inventory has no seat tables yet this sprint, so every trip answers zero
 * sold, zero held and no stations in use. That zero is the honest answer
 * catalog needs to tell "nothing sold" apart from "inventory didn't say" --
 * the counts become real once Sprint 3's seat tables land, with no change
 * to this method's shape.
 */
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
