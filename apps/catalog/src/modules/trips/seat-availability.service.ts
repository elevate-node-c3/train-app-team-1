import { Injectable } from '@nestjs/common';

/**
 * One segment to price availability for: a trip, the two stations the
 * passenger actually travels between, and the class they asked for.
 *
 * `classCapacity` comes from the trip's published composition and is what the
 * provisional implementation answers with. A real inventory backend will
 * ignore it and count held and sold seats on this segment instead.
 */
export interface SegmentAvailabilityQuery {
  tripId: string;
  originStationId: string;
  destinationStationId: string;
  travelClassId: string;
  classCapacity: number;
}

/**
 * How many seats are available, behind one seam.
 *
 * Until inventory exists (Sprint 3, SEAT-4) the answer is the trip's capacity
 * in the requested class. That is honestly provisional: it does not account
 * for a single booking. What is designed now is the *shape* -- this signature,
 * the response field it feeds, and the cache keys, which deliberately do not
 * include availability -- so Sprint 3 changes where the number comes from and
 * nothing else.
 *
 * Batched on purpose. Array in, map out means a real implementation answers N
 * segments in one round trip, and an N+1 cannot creep in through a
 * per-segment signature. The cost of getting this wrong is paid on the hottest
 * read in the system, so the wrong shape is harder to fix later than to choose
 * now.
 */
@Injectable()
export class SeatAvailabilityService {
  /**
   * Seats available per trip, keyed by `tripId`.
   *
   * Zero is a legitimate answer and means sold out: the caller returns the
   * trip marked, rather than hiding it (BR-16). A trip with no coach of the
   * class never reaches here -- the search query excludes it, because that is
   * a different thing from having no seats left.
   */
  async availabilityFor(
    segments: readonly SegmentAvailabilityQuery[],
  ): Promise<Map<string, number>> {
    return new Map(
      segments.map((segment) => [segment.tripId, segment.classCapacity]),
    );
  }
}
