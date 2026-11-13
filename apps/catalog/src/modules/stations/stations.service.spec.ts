import { describe, expect, it, vi } from 'vitest';
import { CacheAsideService, type RedisClientService } from '@app/common';
import { MAX_QUERY_LENGTH } from '../../config/station-search-settings.js';
import type { StationsRepository } from './stations.repository.js';
import {
  StationsService,
  STATIONS_GENERATION_KEY,
  stationsCacheKey,
} from './stations.service.js';
import type { StationCatalogDto } from './stations.types.js';

const CATALOG: StationCatalogDto = {
  governorates: [
    {
      id: 'gharbia',
      name: { en: 'Gharbia', ar: 'الغربية' },
      sortOrder: 2,
      cities: [
        {
          id: 'tanta-city',
          name: { en: 'Tanta', ar: 'طنطا' },
          stations: [
            {
              id: 'tanta',
              name: { en: 'Tanta', ar: 'طنطا' },
              altSpellings: [],
            },
          ],
        },
      ],
    },
    {
      id: 'alexandria',
      name: { en: 'Alexandria', ar: 'الإسكندرية' },
      sortOrder: 1,
      cities: [
        {
          id: 'city-a',
          name: { en: 'Alpha City', ar: 'المدينة الأولى' },
          stations: [
            {
              id: 'sidi',
              name: { en: 'Sidi Gaber', ar: 'سيدي جابر' },
              altSpellings: ['Sidi Jaber'],
            },
          ],
        },
        {
          id: 'city-z',
          name: { en: 'Zulu City', ar: 'المدينة الثانية' },
          stations: [
            {
              id: 'raml-b',
              name: { en: 'El Raml Station', ar: 'محطة الرمل' },
              altSpellings: [],
            },
            {
              id: 'raml-a',
              name: { en: 'El Raml Station', ar: 'محطة الرمل' },
              altSpellings: [],
            },
          ],
        },
      ],
    },
  ],
};

function makeService(stored: unknown = null, available = true) {
  const values = new Map<string, string>();
  if (stored !== null) values.set(stationsCacheKey(1), JSON.stringify(stored));
  const client = {
    get: vi.fn(async (key: string) => values.get(key) ?? null),
    set: vi.fn(async (key: string, value: string, ...options: unknown[]) => {
      if (options.includes('NX') && values.has(key)) return null;
      values.set(key, value);
      return 'OK';
    }),
    incr: vi.fn(async (key: string) => {
      const next = Number(values.get(key) ?? '0') + 1;
      values.set(key, String(next));
      return next;
    }),
    del: vi.fn(async (key: string) => Number(values.delete(key))),
    exists: vi.fn(async (key: string) => Number(values.has(key))),
    eval: vi.fn(
      async (_script: string, _count: number, key: string, token: string) =>
        values.get(key) === token ? Number(values.delete(key)) : 0,
    ),
  };
  const redis = {
    isAvailable: () => available,
    getClient: () => client,
  } as unknown as RedisClientService;
  const cache = new CacheAsideService(redis);
  const repository = {
    findAllActive: vi.fn(async () => structuredClone(CATALOG)),
  };
  const service = new StationsService(
    repository as unknown as StationsRepository,
    cache,
  );
  return { service, repository, client, values, cache };
}

describe('StationsService shared station catalog', () => {
  it('reads the canonical bilingual cache without a repository query', async () => {
    const { service, repository, client } = makeService(CATALOG);
    expect(await service.listStations()).toEqual(CATALOG);
    expect(repository.findAllActive).not.toHaveBeenCalled();
    expect(client.get).toHaveBeenCalledWith(stationsCacheKey(1));
  });

  it('shares the bilingual cache across languages, queries and internal callers', async () => {
    const { service, repository, values } = makeService();
    await service.listStationGroups('en');
    await service.listStationGroups('ar');
    await service.listStationGroups('en', 'tanta');
    expect(await service.listStations()).toEqual(CATALOG);
    expect(repository.findAllActive).toHaveBeenCalledTimes(1);
    expect(JSON.parse(values.get(stationsCacheKey(1))!)).toEqual(CATALOG);
    expect(values.has('catalog:stations:list:v1')).toBe(false);
  });

  it('stores the dev payload with the shared 24-hour jittered TTL', async () => {
    const { service, client } = makeService();
    await service.listStations();
    const call = client.set.mock.calls.find(
      ([key]) => key === stationsCacheKey(1),
    )!;
    expect(call[1]).toBe(JSON.stringify(CATALOG));
    expect(call[2]).toBe('EX');
    expect(call[3]).toBeGreaterThanOrEqual(77_760);
    expect(call[3]).toBeLessThanOrEqual(95_040);
  });

  it('invalidates and rebuilds the same catalog used by the station picker', async () => {
    const { service, repository, client, values } = makeService(CATALOG);
    await service.listStationGroups('en');
    await service.invalidate();
    await service.listStationGroups('ar');
    expect(client.del).toHaveBeenCalledWith(stationsCacheKey(1));
    expect(values.get(STATIONS_GENERATION_KEY)).toBe('2');
    expect(repository.findAllActive).toHaveBeenCalledTimes(1);
  });

  it('moves the generation on every invalidation, never back to the default', async () => {
    const { service, values } = makeService(CATALOG);
    await service.invalidate();
    await service.invalidate();
    expect(values.get(STATIONS_GENERATION_KEY)).toBe('3');
  });

  it('strands a rebuild that read the database before the station changed', async () => {
    const { service, repository, values } = makeService();
    let releaseRead: () => void = () => {};
    const blocked = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    repository.findAllActive.mockImplementationOnce(async () => {
      await blocked;
      return structuredClone(CATALOG);
    });

    // A reader resolves generation 1 and starts a slow rebuild.
    const slowRead = service.listStations();
    await service.invalidate();
    releaseRead();
    await slowRead;

    // Its stale write landed on the superseded generation, so no later read
    // resolves it, and the fresh generation is still a miss.
    expect(values.has(stationsCacheKey(1))).toBe(true);
    expect(values.has(stationsCacheKey(2))).toBe(false);
    await service.listStations();
    expect(repository.findAllActive).toHaveBeenCalledTimes(2);
    expect(JSON.parse(values.get(stationsCacheKey(2))!)).toEqual(CATALOG);
  });

  it('coalesces concurrent cold picker and internal catalog requests', async () => {
    const { service, repository } = makeService();
    await Promise.all([
      service.listStationGroups('ar'),
      service.listStationGroups('en'),
      service.listStations(),
    ]);
    expect(repository.findAllActive).toHaveBeenCalledTimes(1);
  });

  it.each([
    [],
    { governorates: {} },
    { governorates: [{ id: 'broken' }] },
    { governorates: [{ ...CATALOG.governorates[0], cities: [{}] }] },
    {
      governorates: [
        {
          ...CATALOG.governorates[0],
          cities: [{ ...CATALOG.governorates[0].cities[0], stations: [{}] }],
        },
      ],
    },
  ])(
    'rebuilds malformed but readable JSON instead of exposing it: %j',
    async (stored) => {
      const { service, repository } = makeService(stored);
      expect(await service.listStations()).toEqual(CATALOG);
      expect(repository.findAllActive).toHaveBeenCalledTimes(1);
    },
  );

  it('still answers when Redis is unavailable', async () => {
    const { service, repository } = makeService(null, false);
    const result = await service.listStationGroups('en');
    expect(result.governorates).toHaveLength(2);
    expect(repository.findAllActive).toHaveBeenCalledTimes(1);
  });

  it('still supports catalog reads without an injected cache', async () => {
    const repository = { findAllActive: vi.fn(async () => CATALOG) };
    const service = new StationsService(
      repository as unknown as StationsRepository,
    );
    expect(await service.listStations()).toBe(CATALOG);
  });
});

describe('station picker projection', () => {
  it('keeps governorate order and English station order/id ties across cities', async () => {
    const { service } = makeService(CATALOG);
    const result = await service.listStationGroups('ar');
    expect(result.governorates.map((group) => group.id)).toEqual([
      'alexandria',
      'gharbia',
    ]);
    expect(
      result.governorates[0].stations.map((station) => station.id),
    ).toEqual(['raml-a', 'raml-b', 'sidi']);
  });

  it('localizes every projected name without mutating the bilingual cached value', async () => {
    const { service, values } = makeService(CATALOG);
    const before = values.get(stationsCacheKey(1));
    const result = await service.listStationGroups('ar');
    for (const group of result.governorates) {
      expect(group.name).not.toMatch(/[A-Za-z]/);
      for (const station of group.stations) {
        expect(station.name).not.toMatch(/[A-Za-z]/);
        expect(station.cityName).not.toMatch(/[A-Za-z]/);
        expect(Object.keys(station).sort()).toEqual(['cityName', 'id', 'name']);
      }
    }
    expect(values.get(stationsCacheKey(1))).toBe(before);
  });

  it.each([
    ['سيدى جابر', ['sidi']],
    ['sidi jaber', ['sidi']],
    ['zulu', ['raml-a', 'raml-b']],
    ['الغربيه', ['tanta']],
    ['%_', []],
    ['nowhere', []],
    ['', ['raml-a', 'raml-b', 'sidi', 'tanta']],
  ])(
    'matches either language, aliases, cities and governorates for %s',
    async (query, ids) => {
      const { service } = makeService(CATALOG);
      const result = await service.listStationGroups('en', query);
      expect(
        result.governorates.flatMap((group) =>
          group.stations.map((station) => station.id),
        ),
      ).toEqual(ids);
    },
  );

  it.each([undefined, '', 'fr', 'en-US', 42])(
    'rejects language %j before a cache/database read',
    async (language) => {
      const { service, repository, client } = makeService();
      await expect(service.listStationGroups(language)).rejects.toMatchObject({
        details: [
          {
            field: 'language',
            rejectedValue: language,
            issueKey: 'ISSUE_STATION_LANGUAGE_INVALID',
            actionKey: 'ACTION_SET_STATION_LANGUAGE',
          },
        ],
      });
      expect(repository.findAllActive).not.toHaveBeenCalled();
      expect(client.get).not.toHaveBeenCalled();
    },
  );

  it('checks the raw 100-character boundary before normalization', async () => {
    const { service } = makeService(CATALOG);
    await expect(
      service.listStationGroups('en', ' '.repeat(MAX_QUERY_LENGTH)),
    ).resolves.toBeDefined();
    await expect(
      service.listStationGroups('en', ' '.repeat(MAX_QUERY_LENGTH + 1)),
    ).rejects.toMatchObject({
      details: [
        {
          field: 'query',
          issueKey: 'ISSUE_STATION_QUERY_TOO_LONG',
          actionKey: 'ACTION_SHORTEN_STATION_QUERY',
          params: { maxLength: '100' },
        },
      ],
    });
  });
});
