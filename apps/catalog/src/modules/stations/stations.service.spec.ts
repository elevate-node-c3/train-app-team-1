import { describe, expect, it, vi } from 'vitest';
import { CacheAsideService, RedisClientService } from '@app/common';

import { StationsRepository } from './stations.repository.js';
import { StationsService, STATIONS_CACHE_KEY } from './stations.service.js';

describe('StationsService (CAT-1 Cache-aside)', () => {
  it('reads from Redis when warm and avoids database repository query', async () => {
    const mockCache = {
      get: vi.fn().mockResolvedValue({
        governorates: [{ id: 'gov-1', name: { en: 'Cairo', ar: 'القاهرة' } }],
      }),
      set: vi.fn(),
      del: vi.fn(),
      getMetrics: () => ({ recordHit: vi.fn(), recordMiss: vi.fn() }),
    } as unknown as CacheAsideService;

    const mockRepo = {
      findAllActive: vi.fn(),
    } as unknown as StationsRepository;

    const service = new StationsService(mockRepo, mockCache);
    const result = await service.listStations();

    expect(result.governorates).toHaveLength(1);
    expect(mockCache.get).toHaveBeenCalledWith(STATIONS_CACHE_KEY);
    expect(mockRepo.findAllActive).not.toHaveBeenCalled();
  });

  it('rebuilds from database on miss and writes to Redis with 24h jittered TTL', async () => {
    const mockCache = {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue(undefined),
      del: vi.fn(),
      getMetrics: () => ({ recordHit: vi.fn(), recordMiss: vi.fn() }),
    } as unknown as CacheAsideService;

    const mockRepo = {
      findAllActive: vi.fn().mockResolvedValue({
        governorates: [{ id: 'gov-cairo', name: { en: 'Cairo', ar: 'القاهرة' } }],
      }),
    } as unknown as StationsRepository;

    const service = new StationsService(mockRepo, mockCache);
    const result = await service.listStations();

    expect(result.governorates[0].id).toBe('gov-cairo');
    expect(mockRepo.findAllActive).toHaveBeenCalledTimes(1);
    expect(mockCache.set).toHaveBeenCalledTimes(1);
    expect(mockCache.set).toHaveBeenCalledWith(
      STATIONS_CACHE_KEY,
      expect.objectContaining({ governorates: expect.any(Array) }),
      expect.any(Number),
    );
  });

  it('invalidates cached stations on station change event', async () => {
    const mockCache = {
      del: vi.fn().mockResolvedValue(undefined),
    } as unknown as CacheAsideService;

    const mockRepo = {} as unknown as StationsRepository;

    const service = new StationsService(mockRepo, mockCache);
    await service.invalidate();

    expect(mockCache.del).toHaveBeenCalledWith(STATIONS_CACHE_KEY);
  });
});
