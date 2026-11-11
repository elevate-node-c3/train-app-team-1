import { describe, expect, it } from 'vitest';

import { SeatUsageService } from './seat-usage.service.js';

describe('SeatUsageService', () => {
  const service = new SeatUsageService();

  it('answers for every trip it was asked about', async () => {
    const usages = await service.seatUsageForTrips(['trip-a', 'trip-b']);
    expect(usages.map((u) => u.tripId)).toEqual(['trip-a', 'trip-b']);
  });

  // No seat tables this sprint. Zero is the honest answer, and it is an
  // answer -- not an absence. Catalog must be able to tell the difference.
  it('reports no sold or held seats while inventory holds no seats', async () => {
    const [usage] = await service.seatUsageForTrips(['trip-a']);
    expect(usage).toEqual({
      tripId: 'trip-a',
      soldCount: 0,
      heldCount: 0,
      stationIdsInUse: [],
    });
  });

  it('answers an empty request with an empty list', async () => {
    expect(await service.seatUsageForTrips([])).toEqual([]);
  });
});
