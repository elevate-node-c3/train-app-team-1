import { describe, expect, it, vi } from 'vitest';
import type { TripSeatUsage } from '@app/contracts';

import type { SeatUsageRepository } from '../seats/seat-usage.repository.js';
import { SeatUsageService } from './seat-usage.service.js';

function fakeRepository(usages: TripSeatUsage[]): SeatUsageRepository {
  return { usageFor: vi.fn().mockResolvedValue(usages) } as unknown as SeatUsageRepository;
}

describe('SeatUsageService', () => {
  it('passes the trip ids through to the repository and returns its answer', async () => {
    const usages: TripSeatUsage[] = [
      { tripId: 'trip-a', soldCount: 2, heldCount: 1, stationIdsInUse: ['station-1'] },
      { tripId: 'trip-b', soldCount: 0, heldCount: 0, stationIdsInUse: [] },
    ];
    const repository = fakeRepository(usages);
    const service = new SeatUsageService(repository);

    const result = await service.seatUsageForTrips(['trip-a', 'trip-b']);

    expect(repository.usageFor).toHaveBeenCalledWith(['trip-a', 'trip-b']);
    expect(result).toEqual(usages);
  });

  // Zero counts are valid answers, not missing data; the repository decides this,
  // the service just forwards it.
  it('returns a row for every requested trip, including one with no usage', async () => {
    const repository = fakeRepository([
      { tripId: 'trip-a', soldCount: 0, heldCount: 0, stationIdsInUse: [] },
    ]);
    const service = new SeatUsageService(repository);

    expect(await service.seatUsageForTrips(['trip-a'])).toEqual([
      { tripId: 'trip-a', soldCount: 0, heldCount: 0, stationIdsInUse: [] },
    ]);
  });

  it('answers an empty request with an empty list', async () => {
    const repository = fakeRepository([]);
    const service = new SeatUsageService(repository);

    expect(await service.seatUsageForTrips([])).toEqual([]);
    expect(repository.usageFor).toHaveBeenCalledWith([]);
  });
});
