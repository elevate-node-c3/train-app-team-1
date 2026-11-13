import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import type { DataSource } from 'typeorm';
import { CacheAsideService } from '../../libs/common/src/cache/cache-aside.service.js';
import { RedisClientService } from '../../libs/common/src/cache/redis-client.service.js';
import { EVENT_TYPES, type EventEnvelope } from '@app/contracts';
import { CacheInvalidationConsumer } from '../../apps/catalog/src/modules/invalidation/cache-invalidation.consumer.js';
import type { RouteVersionService } from '../../apps/catalog/src/modules/cache/route-version.service.js';
import type { TripStopsService } from '../../apps/catalog/src/modules/trips/trip-stops.service.js';
import { StationsRepository } from '../../apps/catalog/src/modules/stations/stations.repository.js';
import {
  StationsService,
  STATIONS_GENERATION_KEY,
  stationsCacheKey,
} from '../../apps/catalog/src/modules/stations/stations.service.js';
import { GovernorateEntity } from '../../apps/catalog/src/modules/stations/entities/governorate.entity.js';
import { CityEntity } from '../../apps/catalog/src/modules/stations/entities/city.entity.js';
import { StationEntity } from '../../apps/catalog/src/modules/stations/entities/station.entity.js';
import { AddStationAuditTimestamps1794525266218 } from '../../apps/catalog/src/database/migrations/1794525266218-add-station-audit-timestamps.js';
import {
  catalogDataSource,
  closeCatalogDataSource,
  truncateCatalog,
} from './support/catalog-database.js';

const enabled = Boolean(
  process.env.CATALOG_TEST_DATABASE_URL && process.env.REDIS_TEST_URL,
);
const GOVERNORATE = '00000000-0000-4000-8000-000000000001';
const CITY = '00000000-0000-4000-8000-000000000011';
const STATION = '00000000-0000-4000-8000-000000000021';
const INACTIVE = '00000000-0000-4000-8000-000000000022';

/** The counter plus enough generations to cover anything a test bumped. */
const CACHE_KEYS = [
  STATIONS_GENERATION_KEY,
  ...Array.from({ length: 6 }, (_, index) => index + 1).flatMap(
    (generation) => [
      stationsCacheKey(generation),
      `lock:${stationsCacheKey(generation)}`,
    ],
  ),
];

describe.skipIf(!enabled)(
  'station catalog with isolated PostgreSQL and Redis',
  () => {
    let source: DataSource;
    let redis: RedisClientService;
    let repository: StationsRepository;
    let service: StationsService;
    const originalRedisUrl = process.env.REDIS_URL;

    beforeAll(async () => {
      source = await catalogDataSource();
      process.env.REDIS_URL = process.env.REDIS_TEST_URL;
      redis = new RedisClientService();
      await redis.onModuleInit();
      await vi.waitFor(() => expect(redis.isAvailable()).toBe(true), {
        timeout: 5_000,
      });
      repository = new StationsRepository(source);
      service = new StationsService(repository, new CacheAsideService(redis));
    });

    beforeEach(async () => {
      vi.restoreAllMocks();
      await truncateCatalog(source);
      await redis.getClient()!.del(...CACHE_KEYS);
      await source.getRepository(GovernorateEntity).save({
        id: GOVERNORATE,
        nameEn: 'Cairo',
        nameAr: 'القاهرة',
        sortOrder: 1,
      });
      await source.getRepository(CityEntity).save({
        id: CITY,
        governorateId: GOVERNORATE,
        nameEn: 'Cairo',
        nameAr: 'القاهرة',
      });
      await source.getRepository(StationEntity).save([
        {
          id: STATION,
          cityId: CITY,
          nameEn: 'Ramses',
          nameAr: 'رمسيس',
          altSpellings: ['Cairo'],
          isActive: true,
        },
        {
          id: INACTIVE,
          cityId: CITY,
          nameEn: 'Inactive',
          nameAr: 'غير نشطة',
          altSpellings: [],
          isActive: false,
        },
      ]);
    });

    afterAll(async () => {
      if (redis?.getClient()) {
        await redis.getClient()!.del(...CACHE_KEYS);
        await redis.onModuleDestroy();
      }
      if (originalRedisUrl === undefined) delete process.env.REDIS_URL;
      else process.env.REDIS_URL = originalRedisUrl;
      await closeCatalogDataSource();
    });

    it('shares one bilingual Redis value across picker languages and the internal catalog', async () => {
      const read = vi.spyOn(repository, 'findAllActive');
      expect(
        (await service.listStationGroups('en', 'cairo')).governorates[0]
          .stations,
      ).toEqual([{ id: STATION, name: 'Ramses', cityName: 'Cairo' }]);
      expect(
        (await service.listStationGroups('ar', 'القاهرة')).governorates[0]
          .stations,
      ).toEqual([{ id: STATION, name: 'رمسيس', cityName: 'القاهرة' }]);
      const catalog = await service.listStations();
      expect(read).toHaveBeenCalledTimes(1);
      expect(
        JSON.parse((await redis.getClient()!.get(stationsCacheKey(1)))!),
      ).toEqual(catalog);
      expect(catalog.governorates[0].cities[0].stations[0].name).toEqual({
        en: 'Ramses',
        ar: 'رمسيس',
      });
      expect(
        await redis.getClient()!.get('catalog:stations:list:v1'),
      ).toBeNull();
    });

    it('refreshes the picker after the existing station-change invalidation event', async () => {
      await service.listStationGroups('en');
      await source
        .getRepository(StationEntity)
        .update(STATION, { nameEn: 'Updated Ramses' });
      expect(
        (await service.listStationGroups('en')).governorates[0].stations[0]
          .name,
      ).toBe('Ramses');
      const consumer = new CacheInvalidationConsumer(
        {} as RouteVersionService,
        service,
        {} as TripStopsService,
      );
      await consumer.handle({
        id: 'station-change-test',
        type: EVENT_TYPES.stationChanged,
        payload: { stationId: STATION },
      } as EventEnvelope);
      expect(await redis.getClient()!.get(stationsCacheKey(1))).toBeNull();
      expect(await redis.getClient()!.get(STATIONS_GENERATION_KEY)).toBe('2');
      expect(
        (await service.listStationGroups('en')).governorates[0].stations[0]
          .name,
      ).toBe('Updated Ramses');
    });

    it('strands a slow rebuild that read Postgres before the station changed', async () => {
      let releaseRead: () => void = () => {};
      const blocked = new Promise<void>((resolve) => {
        releaseRead = resolve;
      });
      const read = vi
        .spyOn(repository, 'findAllActive')
        .mockImplementationOnce(async () => {
          await blocked;
          return { governorates: [] };
        });

      // Generation 1 is resolved, then the rebuild stalls mid-flight.
      const slowRead = service.listStations();
      await source
        .getRepository(StationEntity)
        .update(STATION, { nameEn: 'Renamed Ramses' });
      await service.invalidate();
      releaseRead();
      await slowRead;
      read.mockRestore();

      // The stale list sits on the superseded generation, unreachable, instead
      // of holding the picker wrong for the full 24-hour TTL.
      expect(await redis.getClient()!.get(stationsCacheKey(2))).toBeNull();
      expect(
        (await service.listStationGroups('en')).governorates[0].stations[0]
          .name,
      ).toBe('Renamed Ramses');
    });

    it('coalesces cold picker requests with a real distributed lock', async () => {
      const read = vi.spyOn(repository, 'findAllActive');
      const requests = Array.from({ length: 20 }, (_, index) =>
        service.listStationGroups(index % 2 ? 'ar' : 'en'),
      );
      const results = await Promise.all(requests);
      expect(read).toHaveBeenCalledTimes(1);
      expect(
        results.every(
          (result) => result.governorates[0].stations[0].id === STATION,
        ),
      ).toBe(true);
    });

    it('rebuilds readable but malformed cached JSON from the database', async () => {
      await redis
        .getClient()!
        .set(stationsCacheKey(1), '{"governorates":[{}]}');
      expect(
        (await service.listStationGroups('en')).governorates[0].stations[0].id,
      ).toBe(STATION);
    });

    it('preserves audit timestamps when the additive migration encounters existing columns', async () => {
      const before = await source.query(
        'SELECT created_at, updated_at FROM station WHERE id = $1',
        [STATION],
      );
      const runner = source.createQueryRunner();
      try {
        await new AddStationAuditTimestamps1794525266218().up(runner);
      } finally {
        await runner.release();
      }
      const after = await source.query(
        'SELECT created_at, updated_at FROM station WHERE id = $1',
        [STATION],
      );
      expect(after).toEqual(before);
      expect(before[0].created_at).toBeInstanceOf(Date);
      expect(before[0].updated_at).toBeInstanceOf(Date);
    });
  },
);
