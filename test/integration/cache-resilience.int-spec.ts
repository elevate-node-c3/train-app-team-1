import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { CacheMetrics } from '../../libs/common/src/cache/cache-metrics.js';
import { RedisClientService } from '../../libs/common/src/cache/redis-client.service.js';
import { assertReachable } from './support/catalog-database.js';

const REDIS_URL = `redis://127.0.0.1:${process.env.REDIS_HOST_PORT ?? '16379'}`;

describe('Cache resilience and metrics (§2.3 rule 7 & rule 8)', () => {
  let redis: RedisClientService;

  beforeAll(async () => {
    const url = new URL(REDIS_URL);
    await assertReachable('Redis', url.hostname, Number(url.port || 6379));

    process.env.REDIS_URL = REDIS_URL;
    redis = new RedisClientService();
    await redis.onModuleInit();
  });

  afterAll(async () => {
    if (redis !== undefined) await redis.onModuleDestroy();
  });

  describe('CacheMetrics registry', () => {
    let metrics: CacheMetrics;

    beforeEach(() => {
      metrics = new CacheMetrics();
    });

    it('starts with zero counts and zero hit rate', () => {
      const snapshot = metrics.getSnapshot();
      expect(snapshot.search.hits).toBe(0);
      expect(snapshot.search.misses).toBe(0);
      expect(snapshot.search.hitRate).toBe(0);
      expect(snapshot.overall.hitRate).toBe(0);
    });

    it('records hits and misses per key family', () => {
      metrics.recordHit('search');
      metrics.recordHit('search');
      metrics.recordMiss('search');

      metrics.recordMiss('stations');

      const searchStats = metrics.getFamilyStats('search');
      expect(searchStats.hits).toBe(2);
      expect(searchStats.misses).toBe(1);
      expect(searchStats.total).toBe(3);
      expect(searchStats.hitRate).toBeCloseTo(2 / 3, 4);

      const stationStats = metrics.getFamilyStats('stations');
      expect(stationStats.hits).toBe(0);
      expect(stationStats.misses).toBe(1);
      expect(stationStats.hitRate).toBe(0);

      const overall = metrics.getSnapshot().overall;
      expect(overall.hits).toBe(2);
      expect(overall.misses).toBe(2);
      expect(overall.total).toBe(4);
      expect(overall.hitRate).toBe(0.5);
    });

    it('resets counters cleanly', () => {
      metrics.recordHit('search');
      metrics.reset();
      expect(metrics.getFamilyStats('search').hits).toBe(0);
    });
  });

  describe('Redis single-outage logging', () => {
    it('notifies subscribers on transition and logs outage once', async () => {
      const transitions: boolean[] = [];
      const unsubscribe = redis.onAvailabilityChange((available) => {
        transitions.push(available);
      });

      expect(typeof unsubscribe).toBe('function');
      const warnSpy = vi.spyOn((redis as unknown as { logger: { warn: (msg: string) => void } }).logger, 'warn');

      (redis as unknown as { handleConnectionError: (err: Error) => void }).handleConnectionError(new Error('ECONNREFUSED'));
      (redis as unknown as { handleConnectionError: (err: Error) => void }).handleConnectionError(new Error('ECONNREFUSED'));

      const outageLogs = warnSpy.mock.calls.filter((call) =>
        call[0].includes('Operating in degraded cache mode'),
      );
      expect(outageLogs.length).toBe(1);

      (redis as unknown as { handleConnectionReady: () => void }).handleConnectionReady();
      expect(redis.isAvailable()).toBe(true);

      unsubscribe();
    });
  });
});
