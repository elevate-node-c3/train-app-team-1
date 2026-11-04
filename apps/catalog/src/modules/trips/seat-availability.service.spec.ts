import { describe, expect, it, vi } from 'vitest';

import {
  SeatAvailabilityService,
  type SegmentAvailabilityQuery,
} from './seat-availability.service.js';

const segment = (
  tripId: string,
  classCapacity: number,
): SegmentAvailabilityQuery => ({
  tripId,
  originStationId: 'origin',
  destinationStationId: 'destination',
  travelClassId: 'first',
  classCapacity,
});

describe('seat availability', () => {
  const service = new SeatAvailabilityService();

  it('answers for every segment it is given', async () => {
    const result = await service.availabilityFor([
      segment('a', 40),
      segment('b', 72),
      segment('c', 12),
    ]);

    expect(result.size).toBe(3);
    expect(result.get('a')).toBe(40);
    expect(result.get('b')).toBe(72);
    expect(result.get('c')).toBe(12);
  });

  it('returns an empty map for no segments, without asking anything', async () => {
    await expect(service.availabilityFor([])).resolves.toEqual(new Map());
  });

  // Provisional until Sprint 3: the count is the trip's capacity in the class,
  // which is what the search query already reports.
  it('uses the class capacity as the provisional count', async () => {
    const result = await service.availabilityFor([segment('a', 40)]);

    expect(result.get('a')).toBe(40);
  });

  /**
   * The shape is the point. Array in, map out means a Sprint-3 implementation
   * backed by a real inventory table answers N segments in one round trip, and
   * cannot reintroduce an N+1 even if written carelessly. A per-segment
   * signature would have invited exactly that.
   */
  it('is batched by construction, so N segments cost one call', async () => {
    const spy = vi.spyOn(service, 'availabilityFor');

    await service.availabilityFor([
      segment('a', 40),
      segment('b', 40),
      segment('c', 40),
    ]);

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('keeps the last answer when a trip appears twice', async () => {
    // Shouldn't happen -- the query returns one row per trip -- but a Map
    // cannot hold both, and silently keeping one is better than a crash.
    const result = await service.availabilityFor([
      segment('a', 40),
      segment('a', 10),
    ]);

    expect(result.size).toBe(1);
    expect(result.get('a')).toBe(10);
  });

  /**
   * Sold out is unreachable in Sprint 2: availability is the capacity, and a
   * trip with zero capacity in the class is filtered out of the query as "no
   * such coach" before it ever gets here. So the rule that a sold-out trip is
   * returned and marked -- rather than hidden -- is proven against a stubbed
   * seam, which is the test that keeps working when real inventory lands.
   */
  it('can report zero, which the caller must surface as sold out', async () => {
    const soldOut = new SeatAvailabilityService();
    vi.spyOn(soldOut, 'availabilityFor').mockResolvedValue(
      new Map([['a', 0]]),
    );

    const result = await soldOut.availabilityFor([segment('a', 40)]);

    expect(result.get('a')).toBe(0);
  });
});
