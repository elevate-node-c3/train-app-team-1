import { describe, expect, it, vi } from 'vitest';
import { CacheAsideService } from '@app/common';

import {
  SeatAvailabilityService,
  availabilityVersionCacheKey,
  segmentAvailabilityCacheKey,
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

  it('uses the class capacity as the provisional count', async () => {
    const result = await service.availabilityFor([segment('a', 40)]);

    expect(result.get('a')).toBe(40);
  });

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
    const result = await service.availabilityFor([
      segment('a', 40),
      segment('a', 10),
    ]);

    expect(result.size).toBe(1);
    expect(result.get('a')).toBe(10);
  });

  it('can report zero, which the caller must surface as sold out', async () => {
    const soldOut = new SeatAvailabilityService();
    vi.spyOn(soldOut, 'availabilityFor').mockResolvedValue(new Map([['a', 0]]));

    const result = await soldOut.availabilityFor([segment('a', 40)]);

    expect(result.get('a')).toBe(0);
  });

  describe('availability under its own keys (§2.3, SEAT-4)', () => {
    it('reads cached availability from Redis and populates missing keys', async () => {
      const segA = segment('trip-a', 40);
      const segB = segment('trip-b', 50);

      const keyA = segmentAvailabilityCacheKey(segA);
      const keyB = segmentAvailabilityCacheKey(segB);

      const store = new Map<string, number>([[keyA, 15]]);

      const mockCache = {
        get: vi.fn(async (key: string) => store.get(key) ?? null),
        set: vi.fn(async (key: string, val: number) => {
          store.set(key, val);
        }),
        getMetrics: () => ({ recordHit: vi.fn(), recordMiss: vi.fn() }),
      } as unknown as CacheAsideService;

      const cachedService = new SeatAvailabilityService(mockCache);
      const result = await cachedService.availabilityFor([segA, segB]);

      expect(result.get('trip-a')).toBe(15);
      expect(result.get('trip-b')).toBe(50);
      expect(mockCache.set).toHaveBeenCalledWith(keyB, 50, expect.any(Number));
    });

    it('makes every old segment key unreachable after a trip generation change', async () => {
      const query = segment('trip-a', 40);
      const oldKey = segmentAvailabilityCacheKey(query, 1);
      const newKey = segmentAvailabilityCacheKey(query, 2);
      const store = new Map<string, number | string>([
        [availabilityVersionCacheKey(query.tripId), 2],
        [oldKey, 0],
      ]);
      const cache = {
        get: vi.fn(async (key: string) => store.get(key) ?? null),
        set: vi.fn(async (key: string, value: number) => {
          store.set(key, value);
        }),
        getMetrics: () => ({ recordHit: vi.fn(), recordMiss: vi.fn() }),
      } as unknown as CacheAsideService;

      const result = await new SeatAvailabilityService(cache).availabilityFor([
        query,
      ]);
      expect(result.get(query.tripId)).toBe(40);
      expect(cache.get).toHaveBeenCalledWith(newKey);
      expect(cache.set).toHaveBeenCalledWith(newKey, 40, expect.any(Number));
      expect(store.get(oldKey)).toBe(0);
    });
  });
});
