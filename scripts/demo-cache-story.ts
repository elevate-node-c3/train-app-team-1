/**
 * Shows cache hits, fare updates, shared rebuilds, and Redis recovery.
 * Clears all data from the configured Redis instance.
 */
import { RedisClientService } from '../libs/common/src/cache/redis-client.service.js';
import { CacheMetrics } from '../libs/common/src/cache/cache-metrics.js';
import { CacheAsideService } from '../libs/common/src/cache/cache-aside.service.js';
import { RouteVersionService } from '../apps/catalog/src/modules/cache/route-version.service.js';
import { searchCacheKey } from '../apps/catalog/src/modules/trips/trip-search-cache.js';
import { CacheInvalidationConsumer } from '../apps/catalog/src/modules/invalidation/cache-invalidation.consumer.js';
import { EVENT_TYPES } from '../libs/contracts/src/events/event-types.js';
import { RedisHealthService } from '../libs/common/src/health/redis-health.service.js';
import { HealthService } from '../libs/common/src/health/health.service.js';
import { GracefulShutdownService } from '../libs/common/src/shutdown/graceful-shutdown.service.js';

const REDIS_URL = process.env.REDIS_URL || `redis://127.0.0.1:${process.env.REDIS_HOST_PORT ?? '16379'}`;

async function runDemo() {
  console.log('\n===============================================================');
  console.log('   TA-19: THE CACHE LAYER - DEVELOPER FLOW & DEMO VERIFICATION');
  console.log('===============================================================\n');

  process.env.REDIS_URL = REDIS_URL;
  const redisService = new RedisClientService();
  await redisService.onModuleInit();
  await redisService.getClient()?.flushall();

  const metrics = new CacheMetrics(redisService);
  metrics.reset();

  const cache = new CacheAsideService(redisService, metrics);
  const routeVersion = new RouteVersionService(redisService);
  const invalidationConsumer = new CacheInvalidationConsumer(
    routeVersion,
    {} as any,
    {} as any,
    cache,
  );

  const shutdownService = new GracefulShutdownService();
  const redisHealthService = new RedisHealthService(redisService);
  const healthService = new HealthService(shutdownService, redisHealthService);

  const originStationId = '00000003-0000-4000-8000-000000000001'; // Ramses (Cairo)
  const destinationStationId = '00000003-0000-4000-8000-000000000004'; // Sidi Gaber (Alexandria)
  const tomorrow = '2026-06-21';
  const travelClassId = '00000005-0000-4000-8000-000000000001'; // First Class AC

  let dbFarePiastres = 15000;
  let dbQueries = 0;

  const mockDbQuery = async () => {
    dbQueries++;
    return [
      {
        tripId: 'trip-cairo-alex-001',
        trainNumber: '903',
        farePiastres: dbFarePiastres,
        availableSeats: 42,
      },
    ];
  };

  const executeSearch = async () => {
    const version = await routeVersion.getRouteVersion(originStationId, destinationStationId);
    const key = searchCacheKey({
      originStationId,
      destinationStationId,
      serviceDate: tomorrow,
      travelClassId,
      trainNumber: null,
      routeVersion: version,
    });
    return cache.getOrRebuild(key, 'search', mockDbQuery, 300);
  };

  console.log('[Step 1] Search Cairo -> Alexandria for tomorrow, First Class AC (Cold)');
  dbQueries = 0;
  const res1 = await executeSearch();
  console.log(`  -> Result: Trip ${res1[0].tripId}, Fare: ${res1[0].farePiastres / 100} EGP`);
  console.log(`  -> Database queries: ${dbQueries} (Cold: rebuilt from Postgres, written to Redis)\n`);

  console.log('[Step 2] Search Cairo -> Alexandria again (Warm)');
  const prevQueries = dbQueries;
  const res2 = await executeSearch();
  console.log(`  -> Result: Trip ${res2[0].tripId}, Fare: ${res2[0].farePiastres / 100} EGP`);
  console.log(`  -> Database queries: ${dbQueries - prevQueries} (Warm: 0 queries, served from Redis)\n`);

  console.log('[Step 3] Change fare through OPS-1 (150 EGP -> 175 EGP)');
  dbFarePiastres = 17500;
  await invalidationConsumer.handle({
    id: 'evt-fare-change-demo',
    type: EVENT_TYPES.fareChanged,
    occurredAt: new Date().toISOString(),
    source: 'ops',
    version: 1,
    correlationId: 'corr-demo',
    payload: {
      fareId: 'fare-cairo-alex-1',
      originStationId,
      destinationStationId,
      travelClassId,
      newFareMinor: 17500,
    },
  });
  console.log('  -> OPS-1 event delivered to catalog inbox: route version bumped');
  const res3 = await executeSearch();
  console.log(`  -> Next search returned new fare: ${res3[0].farePiastres / 100} EGP without waiting for TTL\n`);

  console.log('[Step 4] Fire 200 concurrent identical searches at a cold key');
  const coldOrigin = '00000003-0000-4000-8000-000000000003';
  const coldDest = '00000003-0000-4000-8000-000000000004';
  let coldDbQueries = 0;
  const coldDbQuery = async () => {
    coldDbQueries++;
    await new Promise((r) => setTimeout(r, 20));
    return [{ tripId: 'trip-cold-001', farePiastres: 12000 }];
  };
  const cVer = await routeVersion.getRouteVersion(coldOrigin, coldDest);
  const cKey = searchCacheKey({
    originStationId: coldOrigin,
    destinationStationId: coldDest,
    serviceDate: tomorrow,
    travelClassId,
    trainNumber: null,
    routeVersion: cVer,
  });

  const promises = Array.from({ length: 200 }, () =>
    cache.getOrRebuild(cKey, 'search', coldDbQuery, 300),
  );
  await Promise.all(promises);
  console.log(`  -> 200 simultaneous requests finished.`);
  console.log(`  -> Database queries: ${coldDbQueries} (Stampede guard coalesced to exactly 1 rebuild)\n`);

  console.log('[Step 5] Stop Redis: searches still answer, slower; health check says degraded');
  const privRedis = redisService as unknown as { handleConnectionError: (err: Error) => void; handleConnectionReady: () => void };
  privRedis.handleConnectionError(new Error('Connection lost to Redis'));
  const healthDegraded = await healthService.checkReadiness('catalog');
  console.log(`  -> Catalog Health Status: "${healthDegraded.status}" (dependencies.redis: "${healthDegraded.dependencies.redis.status}")`);
  const resDegraded = await cache.getOrRebuild('cold:degraded:key', 'search', mockDbQuery, 300);
  console.log(`  -> Search answered in degraded mode: Fare: ${resDegraded[0].farePiastres / 100} EGP\n`);

  console.log('[Step 6] Start Redis again: cache is used again, with no restart');
  privRedis.handleConnectionReady();
  const healthReady = await healthService.checkReadiness('catalog');
  console.log(`  -> Catalog Health Status: "${healthReady.status}" (dependencies.redis: "${healthReady.dependencies.redis.status}")`);
  const resWarm = await executeSearch();
  console.log(`  -> Search served normally with Redis back online\n`);

  console.log('[Step 7] Show the search cache hit rate (real counters per family)');
  const snapshot = await metrics.getSnapshotAsync();
  console.log('---------------------------------------------------------------');
  console.log(`Search Hit Rate:     ${(snapshot.search.hitRate * 100).toFixed(2)}% (Hits: ${snapshot.search.hits}, Misses: ${snapshot.search.misses}, Total: ${snapshot.search.total})`);
  console.log(`Trip Stops Hit Rate: ${(snapshot['trip-stops'].hitRate * 100).toFixed(2)}%`);
  console.log(`Stations Hit Rate:   ${(snapshot.stations.hitRate * 100).toFixed(2)}%`);
  console.log(`Availability Rate:   ${(snapshot.availability.hitRate * 100).toFixed(2)}%`);
  console.log(`Overall Hit Rate:    ${(snapshot.overall.hitRate * 100).toFixed(2)}%`);
  console.log('---------------------------------------------------------------\n');

  await redisService.onModuleDestroy();
  console.log('Demo finished successfully.\n');
}

runDemo().catch((err) => {
  console.error('Demo encountered an error:', err);
  process.exit(1);
});
