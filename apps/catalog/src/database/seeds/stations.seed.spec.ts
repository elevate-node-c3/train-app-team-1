import type { INestApplicationContext } from '@nestjs/common';
import { DataSource, type EntityManager, type FindOperator } from 'typeorm';
import { v5 as uuidv5 } from 'uuid';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StationChangedEvent } from '@app/contracts/events/catalog-events.js';
import {
  UNIT_OF_WORK,
  type TransactionContext,
} from '@app/common/persistence/unit-of-work.port.js';
import { OUTBOX } from '@app/messaging/outbox/outbox.port.js';

const bootstrap = vi.hoisted(() => vi.fn());
const unwrap = vi.hoisted(() => vi.fn());
vi.mock('@app/common/persistence/typeorm-unit-of-work.js', () => ({
  entityManagerOf: unwrap,
}));
vi.mock('@nestjs/core', () => ({
  NestFactory: { createApplicationContext: bootstrap },
}));
vi.mock('../../catalog.module.js', () => ({
  CatalogModule: class CatalogModule {},
}));
vi.mock('../../modules/stations/stations.service.js', () => ({
  StationsService: class StationsService {},
}));
vi.mock('../../modules/timetables/timetables.service.js', () => ({
  TimetablesService: class TimetablesService {},
}));
vi.mock('../data-source.js', () => {
  throw new Error(
    'Seeds must use the application DataSource, not initialize a standalone connection',
  );
});

import { CatalogModule } from '../../catalog.module.js';
import { StationsService } from '../../modules/stations/stations.service.js';
import { TimetablesService } from '../../modules/timetables/timetables.service.js';
import { main as catalogMain, seedCatalog } from './catalog.seed.js';
import { main as stationsMain, seedStations } from './stations.seed.js';
import { CATALOG_STATION_IDS, governorates } from './stations.js';

type Row = { id: string; [column: string]: unknown };
const contextManagers = new WeakMap<TransactionContext, EntityManager>();
const namespace = '6f1c1d0e-5a4b-4c53-9a47-2d3f9b1e7a10';
const deterministicId = (kind: string, slug: string) =>
  uuidv5(`${kind}:${slug}`, namespace);
const devGovernorates = [
  { id: '00000000-0000-4000-8000-000000000001', nameEn: 'Cairo', sortOrder: 1 },
  { id: '00000000-0000-4000-8000-000000000002', nameEn: 'Giza', sortOrder: 2 },
  {
    id: '00000000-0000-4000-8000-000000000003',
    nameEn: 'Beni Suef',
    sortOrder: 3,
  },
];

function fakeApp(
  options: {
    initial?: Record<string, Row[]>;
    commitError?: Error;
    appendError?: Error;
    failAppendAt?: number;
    saveErrorAt?: string;
  } = {},
) {
  const tables = new Map<string, Map<string, Row>>();
  const events: string[] = [];
  const envelopes: StationChangedEvent[] = [];
  const contexts: TransactionContext[] = [];
  const businessContexts: (TransactionContext | undefined)[] = [];
  let activeContext: TransactionContext | undefined;
  const table = (name: string) => {
    if (!tables.has(name)) tables.set(name, new Map());
    return tables.get(name)!;
  };
  const rows = (name: string) => structuredClone([...table(name).values()]);
  for (const [name, initialRows] of Object.entries(options.initial ?? {})) {
    for (const row of initialRows)
      table(name).set(row.id, structuredClone(row));
  }

  function createRepository(name: string) {
    const write = (row: Row) => {
      businessContexts.push(activeContext);
      const existing = table(name).get(row.id);
      const next: Row = {
        ...(name === 'StationEntity' && !existing ? { isActive: true } : {}),
        ...existing,
        ...structuredClone(row),
      };
      // Enforce uniqueness immediately, not just at fake transaction commit.
      if (
        name === 'GovernorateEntity' &&
        [...table(name).values()].some(
          (other) => other.id !== row.id && other.sortOrder === next.sortOrder,
        )
      )
        throw new Error(`duplicate sort_order ${String(next.sortOrder)}`);
      if (
        name === 'CityEntity' &&
        !table('GovernorateEntity').has(String(next.governorateId))
      ) {
        throw new Error('missing governorate reference');
      }
      if (
        name === 'StationEntity' &&
        !table('CityEntity').has(String(next.cityId))
      ) {
        throw new Error('missing city reference');
      }
      table(name).set(row.id, next);
    };
    return {
      find: vi.fn(
        async (options?: {
          where?: { id?: FindOperator<string[]> };
          order?: { sortOrder?: string };
          select?: Record<string, boolean>;
        }) => {
          const ids = options?.where?.id?.value;
          const found = rows(name).filter(
            (row) => !ids || ids.includes(row.id),
          );
          if (
            name === 'GovernorateEntity' &&
            options?.order?.sortOrder === 'ASC'
          ) {
            found.sort(
              (a, b) =>
                Number(a.sortOrder) - Number(b.sortOrder) ||
                a.id.localeCompare(b.id),
            );
          }
          return options?.select
            ? found.map(
                (row) =>
                  Object.fromEntries(
                    Object.entries(row).filter(
                      ([column]) => options.select?.[column],
                    ),
                  ) as Row,
              )
            : found;
        },
      ),
      findOne: vi.fn(async (options: { where: { id: string } }) =>
        structuredClone(table(name).get(options.where.id) ?? null),
      ),
      upsert: vi.fn(async (incoming: Row[], conflictPaths: string[]) => {
        expect(conflictPaths).toEqual(['id']);
        events.push(`upsert:${name}`);
        incoming.forEach(write);
      }),
      update: vi.fn(async (id: string, changes: Partial<Row>) => {
        events.push(`update:${name}`);
        write({ ...table(name).get(id)!, ...changes, id });
      }),
      save: vi.fn(async (incoming: Row | Row[]) => {
        events.push(`save:${name}`);
        if (options.saveErrorAt === name) throw new Error('save failed');
        (Array.isArray(incoming) ? incoming : [incoming]).forEach(write);
      }),
    };
  }
  const repositories = new Map<string, ReturnType<typeof createRepository>>();
  const repository = (name: string) => {
    if (!repositories.has(name)) repositories.set(name, createRepository(name));
    return repositories.get(name)!;
  };
  const manager = {
    query: vi.fn(async (sql: string) => {
      expect(sql).toBe(
        'LOCK TABLE "governorate", "station" IN SHARE ROW EXCLUSIVE MODE',
      );
      expect(events.at(-1)).toBe('begin');
      events.push('lock');
    }),
    getRepository: vi.fn((target: { name: string }) => repository(target.name)),
  } as unknown as EntityManager;
  const source = {
    transaction: vi.fn(
      async (work: (manager: EntityManager) => Promise<void>) => {
        const snapshot = structuredClone(tables);
        const envelopeCount = envelopes.length;
        events.push('begin');
        try {
          await work(manager);
          if (options.commitError) throw options.commitError;
          events.push('commit');
        } catch (error) {
          tables.clear();
          for (const [name, contents] of snapshot) tables.set(name, contents);
          envelopes.length = envelopeCount;
          events.push('rollback');
          throw error;
        }
      },
    ),
  };
  const unitOfWork = {
    withTransaction: vi.fn(
      async (work: (ctx: TransactionContext) => Promise<void>) =>
        source.transaction(async (transactionManager) => {
          const ctx: TransactionContext = { driver: 'fake-seed' };
          contexts.push(ctx);
          contextManagers.set(ctx, transactionManager);
          activeContext = ctx;
          try {
            await work(ctx);
          } finally {
            activeContext = undefined;
          }
        }),
    ),
  };
  let appendAttempts = 0;
  const append = vi.fn(
    async (ctx: TransactionContext, envelope: StationChangedEvent) => {
      expect(ctx).toBe(activeContext);
      expect(contextManagers.get(ctx)).toBe(manager);
      expect(events).toContain('upsert:StationEntity');
      events.push('append');
      appendAttempts++;
      if (
        options.appendError &&
        appendAttempts === (options.failAppendAt ?? 1)
      ) {
        throw options.appendError;
      }
      envelopes.push(structuredClone(envelope));
    },
  );
  const invalidate = vi.fn(async () => {
    expect(events.at(-1)).toBe('commit');
    events.push('invalidate');
  });
  const publishTimetable = vi.fn(async (id: string) => {
    expect(events.at(-1)).toBe('invalidate');
    events.push('publish');
    table('TimetableEntity').get(id)!.status = 'published';
  });
  const close = vi.fn(async () => {
    events.push('close');
  });
  const app = {
    get: vi.fn((token: unknown) => {
      if (token === DataSource) return source;
      if (token === UNIT_OF_WORK) return unitOfWork;
      if (token === OUTBOX) return { append };
      if (token === StationsService) return { invalidate };
      if (token === TimetablesService) return { publishTimetable };
      throw new Error('Unexpected application provider');
    }),
    close,
  } as unknown as INestApplicationContext;
  return {
    app,
    rows,
    table,
    repository,
    events,
    source,
    unitOfWork,
    envelopes,
    append,
    contexts,
    businessContexts,
    invalidate,
    publishTimetable,
    close,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  bootstrap.mockReset();
  unwrap.mockImplementation((ctx: TransactionContext) => {
    const manager = contextManagers.get(ctx);
    if (!manager) throw new Error('Unknown fake transaction context');
    return manager;
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('shared station seed', () => {
  it('imports both seed modules without bootstrapping or changing job settings', async () => {
    vi.stubEnv('OUTBOX_RELAY_ENABLED', 'original-relay');
    vi.stubEnv('TRIP_GENERATION_ENABLED', 'original-generation');
    vi.resetModules();

    await import('./stations.seed.js');
    await import('./catalog.seed.js');

    expect(bootstrap).not.toHaveBeenCalled();
    expect(process.env.OUTBOX_RELAY_ENABLED).toBe('original-relay');
    expect(process.env.TRIP_GENERATION_ENABLED).toBe('original-generation');
  });

  it('retains all 20 governorates in branch order with canonical dev IDs and deterministic additions', async () => {
    const fixture = fakeApp();
    await seedStations(fixture.app);

    expect(governorates.map((row) => row.slug)).toEqual([
      'cairo',
      'giza',
      'alexandria',
      'qalyubia',
      'monufia',
      'beheira',
      'kafr-el-sheikh',
      'dakahlia',
      'sharqia',
      'gharbia',
      'ismailia',
      'damietta',
      'port-said',
      'beni-suef',
      'minya',
      'assiut',
      'sohag',
      'qena',
      'luxor',
      'aswan',
    ]);
    expect(fixture.rows('GovernorateEntity')).toHaveLength(20);
    expect(fixture.rows('CityEntity')).toHaveLength(21);
    expect(fixture.rows('StationEntity')).toHaveLength(22);
    expect(CATALOG_STATION_IDS).toEqual({
      cairo: '00000000-0000-4000-8000-000000000021',
      giza: '00000000-0000-4000-8000-000000000022',
      beniSuef: '00000000-0000-4000-8000-000000000023',
    });
    for (const [slug, suffix] of [
      ['cairo', '1'],
      ['giza', '2'],
      ['beni-suef', '3'],
    ]) {
      expect(governorates.find((row) => row.slug === slug)?.id).toBe(
        `00000000-0000-4000-8000-00000000000${suffix}`,
      );
      expect(governorates.find((row) => row.slug === slug)?.cities[0].id).toBe(
        `00000000-0000-4000-8000-00000000001${suffix}`,
      );
    }
    for (const [index, governorate] of governorates.entries()) {
      const governorateId =
        governorate.id ?? deterministicId('governorate', governorate.slug);
      expect(
        fixture.table('GovernorateEntity').get(governorateId),
      ).toMatchObject({
        nameAr: governorate.nameAr,
        nameEn: governorate.nameEn,
        sortOrder: index + 1,
      });
      for (const city of governorate.cities) {
        const cityId = city.id ?? deterministicId('city', city.slug);
        expect(fixture.table('CityEntity').get(cityId)).toMatchObject({
          governorateId,
        });
        for (const station of city.stations) {
          const id = station.id ?? deterministicId('station', station.slug);
          expect(fixture.table('StationEntity').get(id)).toMatchObject({
            cityId,
            nameAr: station.nameAr,
            nameEn: station.nameEn,
            isActive: true,
          });
        }
      }
    }
    expect(
      fixture
        .rows('GovernorateEntity')
        .find((row) => row.nameEn === 'Beni Suef')?.sortOrder,
    ).toBe(14);
  });

  it('keeps branch aliases plus incoming English and Arabic station spellings', async () => {
    const fixture = fakeApp();
    await seedStations(fixture.app);

    const aliases = (id: string) =>
      fixture.table('StationEntity').get(id)?.altSpellings;
    expect(aliases(CATALOG_STATION_IDS.cairo)).toEqual([
      'Ramses',
      'Ramses Station',
      'Cairo Ramses',
    ]);
    expect(aliases(CATALOG_STATION_IDS.giza)).toEqual([
      'Giza',
      'Giza Station',
      '\u0645\u062d\u0637\u0629 \u0627\u0644\u062c\u064a\u0632\u0629',
    ]);
    expect(aliases(CATALOG_STATION_IDS.beniSuef)).toEqual([
      'Beni Suef',
      'Beni Suef Station',
      '\u0645\u062d\u0637\u0629 \u0628\u0646\u064a \u0633\u0648\u064a\u0641',
    ]);
    expect(aliases(deterministicId('station', 'banha'))).toEqual(['Benha']);
    expect(aliases(deterministicId('station', 'shibin-el-kom'))).toEqual([
      'Shebin El Kom',
    ]);
    expect(aliases(deterministicId('station', 'assiut'))).toEqual(['Asyut']);
  });

  it('reorders dev Beni Suef without unique collisions and preserves unrelated rows in a stable dense tail', async () => {
    const unrelated = [
      { id: 'other-z', nameEn: 'Other Z', sortOrder: 4 },
      { id: 'other-a', nameEn: 'Other A', sortOrder: -1 },
      { id: 'other-max', nameEn: 'Other Max', sortOrder: 2_147_483_647 },
    ];
    const city = {
      id: 'other-city',
      governorateId: 'other-z',
      nameEn: 'Existing city',
    };
    const station = {
      id: 'other-station',
      cityId: city.id,
      nameEn: 'Existing station',
      altSpellings: ['Existing alias'],
      isActive: false,
    };
    const fixture = fakeApp({
      initial: {
        GovernorateEntity: [...devGovernorates, ...unrelated],
        CityEntity: [city],
        StationEntity: [station],
      },
    });

    await seedStations(fixture.app);
    const first = fixture.rows('GovernorateEntity');
    await seedStations(fixture.app);

    expect(fixture.rows('GovernorateEntity')).toEqual(first);
    expect(
      [...fixture.rows('GovernorateEntity')]
        .sort((a, b) => Number(a.sortOrder) - Number(b.sortOrder))
        .map((row) => row.sortOrder),
    ).toEqual(Array.from({ length: 23 }, (_, index) => index + 1));
    for (const [index, row] of [
      unrelated[1],
      unrelated[0],
      unrelated[2],
    ].entries()) {
      expect(fixture.table('GovernorateEntity').get(row.id)).toEqual({
        ...row,
        sortOrder: 21 + index,
      });
    }
    expect(fixture.table('CityEntity').get(city.id)).toEqual(city);
    expect(fixture.table('StationEntity').get(station.id)).toEqual(station);
  });

  for (const [label, seed] of [
    ['stations', seedStations],
    ['catalog', seedCatalog],
  ] as const) {
    it(`${label} seed appends 22 complete created events using the business transaction's opaque context`, async () => {
      const fixture = fakeApp();
      const startedAt = Date.now();

      await seed(fixture.app);

      expect(fixture.envelopes).toHaveLength(22);
      expect(fixture.append).toHaveBeenCalledTimes(22);
      expect(fixture.unitOfWork.withTransaction).toHaveBeenCalledTimes(1);
      expect(fixture.source.transaction).toHaveBeenCalledTimes(1);
      expect(fixture.contexts).toHaveLength(1);
      expect(fixture.businessContexts.length).toBeGreaterThan(0);
      expect(
        fixture.businessContexts.every((ctx) => ctx === fixture.contexts[0]),
      ).toBe(true);
      expect(
        fixture.append.mock.calls.every(([ctx]) => ctx === fixture.contexts[0]),
      ).toBe(true);
      expect(fixture.contexts[0]).not.toHaveProperty('manager');
      expect(unwrap).toHaveBeenCalledWith(fixture.contexts[0]);
      expect(new Set(fixture.envelopes.map((event) => event.id)).size).toBe(22);
      expect(
        new Set(fixture.envelopes.map((event) => event.correlationId)).size,
      ).toBe(1);
      expect(fixture.events.indexOf('append')).toBeGreaterThan(
        fixture.events.indexOf('upsert:StationEntity'),
      );
      expect(fixture.events.lastIndexOf('append')).toBeLessThan(
        fixture.events.indexOf('commit'),
      );
      expect(fixture.envelopes.map((event) => event.payload.stationId)).toEqual(
        fixture.rows('StationEntity').map((station) => station.id),
      );
      for (const event of fixture.envelopes) {
        const station = fixture
          .table('StationEntity')
          .get(event.payload.stationId)!;
        const city = fixture.table('CityEntity').get(String(station.cityId))!;
        const governorate = fixture
          .table('GovernorateEntity')
          .get(String(city.governorateId))!;
        expect(event).toMatchObject({
          type: 'catalog.station.changed',
          version: 1,
          producer: 'catalog',
        });
        expect(event.id).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
        );
        expect(event.correlationId).toMatch(/^[0-9a-f-]{36}$/);
        expect(event.id).not.toBe(station.id);
        expect(Date.parse(event.occurredAt)).toBeGreaterThanOrEqual(startedAt);
        expect(Date.parse(event.occurredAt)).toBeLessThanOrEqual(Date.now());
        expect(event.payload).toEqual({
          stationId: station.id,
          action: 'created',
          nameAr: station.nameAr,
          nameEn: station.nameEn,
          cityId: city.id,
          governorateId: governorate.id,
          cityName: { ar: city.nameAr, en: city.nameEn },
          governorateName: { ar: governorate.nameAr, en: governorate.nameEn },
          altSpellings: station.altSpellings,
          isActive: station.isActive,
        });
      }
    });

    it(`${label} seed emits no events on an identical replay, including inactive rows and audit-only changes`, async () => {
      const fixture = fakeApp();
      await seed(fixture.app);
      for (const row of fixture.table('StationEntity').values()) {
        row.createdAt = new Date('2020-01-01');
        row.updatedAt = new Date('2021-01-01');
      }
      const inactive = fixture
        .table('StationEntity')
        .get(CATALOG_STATION_IDS.cairo)!;
      inactive.isActive = false;
      inactive.altSpellings = [
        ...(inactive.altSpellings as string[]),
        'Custom spelling',
      ];

      await seed(fixture.app);

      expect(fixture.envelopes).toHaveLength(22);
      expect(fixture.append).toHaveBeenCalledTimes(22);
      expect(fixture.table('StationEntity').get(inactive.id)?.isActive).toBe(
        false,
      );
      expect(fixture.invalidate).toHaveBeenCalledTimes(2);
    });

    it.each([
      ['nameEn', 'Old English name'],
      ['nameAr', 'Old Arabic name'],
      ['cityId', '00000000-0000-4000-8000-000000000012'],
      ['altSpellings', ['Custom alias']],
    ])(
      `${label} seed emits exactly one updated snapshot for a real %s change without reactivation`,
      async (field, value) => {
        const fixture = fakeApp();
        await seed(fixture.app);
        const station = fixture
          .table('StationEntity')
          .get(CATALOG_STATION_IDS.cairo)!;
        station[field as string] = value;
        station.isActive = false;

        await seed(fixture.app);

        const updated = fixture.envelopes.slice(22);
        expect(updated).toHaveLength(1);
        expect(updated[0].payload).toMatchObject({
          stationId: CATALOG_STATION_IDS.cairo,
          action: 'updated',
          isActive: false,
          cityId: '00000000-0000-4000-8000-000000000011',
          governorateId: '00000000-0000-4000-8000-000000000001',
          nameAr: governorates[0].cities[0].stations[0].nameAr,
          nameEn: governorates[0].cities[0].stations[0].nameEn,
          cityName: {
            ar: governorates[0].cities[0].nameAr,
            en: governorates[0].cities[0].nameEn,
          },
          governorateName: {
            ar: governorates[0].nameAr,
            en: governorates[0].nameEn,
          },
          altSpellings: fixture.table('StationEntity').get(station.id)
            ?.altSpellings,
        });
        expect(updated[0].correlationId).not.toBe(
          fixture.envelopes[0].correlationId,
        );
        expect(fixture.table('StationEntity').get(station.id)?.isActive).toBe(
          false,
        );

        await seed(fixture.app);
        expect(fixture.append).toHaveBeenCalledTimes(23);
        expect(fixture.envelopes).toHaveLength(23);
      },
    );

    it(`${label} seed rolls back writes and prior appends on an outbox failure, without invalidating`, async () => {
      const fixture = fakeApp({
        initial: { GovernorateEntity: devGovernorates },
        appendError: new Error('outbox append failed'),
        failAppendAt: 5,
      });

      await expect(seed(fixture.app)).rejects.toThrow('outbox append failed');

      expect(fixture.rows('GovernorateEntity')).toEqual(devGovernorates);
      expect(fixture.rows('CityEntity')).toEqual([]);
      expect(fixture.rows('StationEntity')).toEqual([]);
      expect(fixture.rows('TrainEntity')).toEqual([]);
      expect(fixture.envelopes).toEqual([]);
      expect(fixture.append).toHaveBeenCalledTimes(5);
      expect(fixture.events.at(-1)).toBe('rollback');
      expect(fixture.invalidate).not.toHaveBeenCalled();
      expect(fixture.publishTimetable).not.toHaveBeenCalled();
    });

    it(`${label} seed is idempotent, preserves existing aliases and never updates isActive`, async () => {
      const fixture = fakeApp();
      await seed(fixture.app);
      const deactivated = fixture
        .table('StationEntity')
        .get(CATALOG_STATION_IDS.cairo)!;
      deactivated.isActive = false;
      deactivated.altSpellings = [
        ...(deactivated.altSpellings as string[]),
        'Custom spelling',
      ];

      await seed(fixture.app);
      const first = fixture.rows('StationEntity');
      await seed(fixture.app);

      expect(fixture.rows('StationEntity')).toEqual(first);
      expect(fixture.rows('StationEntity')).toHaveLength(22);
      expect(fixture.rows('GovernorateEntity')).toHaveLength(20);
      expect(fixture.rows('CityEntity')).toHaveLength(21);
      expect(
        fixture.table('StationEntity').get(CATALOG_STATION_IDS.cairo),
      ).toMatchObject({
        isActive: false,
        altSpellings: [
          'Ramses',
          'Ramses Station',
          'Cairo Ramses',
          'Custom spelling',
        ],
      });
      for (const [incoming] of fixture.repository('StationEntity').upsert.mock
        .calls) {
        for (const row of incoming) expect(row).not.toHaveProperty('isActive');
      }
      expect(fixture.repository('StationEntity').save).not.toHaveBeenCalled();
      expect(fixture.invalidate).toHaveBeenCalledTimes(3);
    });

    it(`${label} seed invalidates only after commit, not after a failed transaction`, async () => {
      const success = fakeApp();
      await seed(success.app);
      expect(success.events.indexOf('invalidate')).toBe(
        success.events.indexOf('commit') + 1,
      );

      const failure = fakeApp({
        initial: { GovernorateEntity: devGovernorates },
        commitError: new Error('commit failed'),
      });
      await expect(seed(failure.app)).rejects.toThrow('commit failed');
      expect(failure.rows('GovernorateEntity')).toEqual(devGovernorates);
      expect(failure.rows('CityEntity')).toEqual([]);
      expect(failure.rows('StationEntity')).toEqual([]);
      expect(failure.rows('TrainEntity')).toEqual([]);
      expect(failure.rows('FareEntity')).toEqual([]);
      expect(failure.envelopes).toEqual([]);
      expect(failure.append).toHaveBeenCalledTimes(22);
      expect(failure.events.at(-1)).toBe('rollback');
      expect(failure.invalidate).not.toHaveBeenCalled();
      expect(failure.publishTimetable).not.toHaveBeenCalled();
    });
  }

  it('rolls back full catalog business writes and station events when a later fare write fails', async () => {
    const fixture = fakeApp({ saveErrorAt: 'FareEntity' });

    await expect(seedCatalog(fixture.app)).rejects.toThrow('save failed');

    expect(fixture.append).toHaveBeenCalledTimes(22);
    expect(fixture.events).toContain('save:FareEntity');
    for (const name of [
      'GovernorateEntity',
      'CityEntity',
      'StationEntity',
      'TrainTypeEntity',
      'TravelClassEntity',
      'CoachLayoutEntity',
      'TrainEntity',
      'TrainCoachEntity',
      'TimetableEntity',
      'TimetableStopEntity',
      'FareEntity',
    ])
      expect(fixture.rows(name)).toEqual([]);
    expect(fixture.envelopes).toEqual([]);
    expect(fixture.events.at(-1)).toBe('rollback');
    expect(fixture.invalidate).not.toHaveBeenCalled();
    expect(fixture.publishTimetable).not.toHaveBeenCalled();
  });

  it.each([
    [
      'GovernorateEntity',
      'cdaff39c-566c-5596-9b79-197b2cdcb5b6',
      '00000000-0000-4000-8000-000000000001',
    ],
    [
      'GovernorateEntity',
      'e941ea89-06d3-557e-91e8-e71ff8d30534',
      '00000000-0000-4000-8000-000000000002',
    ],
    [
      'GovernorateEntity',
      '8ca38d68-75b0-5318-b290-d73bec28ff63',
      '00000000-0000-4000-8000-000000000003',
    ],
    [
      'CityEntity',
      '30850f8f-27f2-54b6-94ae-70a4407de6ab',
      '00000000-0000-4000-8000-000000000011',
    ],
    [
      'CityEntity',
      'ba4942bb-9ea6-51dd-8c9e-3e9a40245fd7',
      '00000000-0000-4000-8000-000000000012',
    ],
    [
      'CityEntity',
      '4c7a9ac7-0cc6-55f2-845c-c7f56a316261',
      '00000000-0000-4000-8000-000000000013',
    ],
    [
      'StationEntity',
      '1b59cbca-4676-5f96-bf78-7bd3728b76a2',
      '00000000-0000-4000-8000-000000000021',
    ],
    [
      'StationEntity',
      '677377a6-3b05-5bf5-92cc-c463e828a21f',
      '00000000-0000-4000-8000-000000000022',
    ],
    [
      'StationEntity',
      'cab378f6-3d67-5565-99a7-b3af7b2c26f0',
      '00000000-0000-4000-8000-000000000023',
    ],
  ])(
    'rejects known legacy %s ID %s without deleting, re-keying or inserting an active duplicate',
    async (name, legacyId, canonicalId) => {
      const legacy = {
        id: legacyId,
        sortOrder: 1,
        nameEn: 'Legacy',
        isActive: false,
      };
      const fixture = fakeApp({ initial: { [name]: [legacy] } });

      await expect(seedStations(fixture.app)).rejects.toThrow(
        `${legacyId} => ${canonicalId}`,
      );

      expect(fixture.rows(name)).toEqual([legacy]);
      expect(fixture.table(name).has(canonicalId)).toBe(false);
      expect(fixture.events).toEqual(['begin', 'lock', 'rollback']);
      expect(fixture.invalidate).not.toHaveBeenCalled();
    },
  );

  it('keeps dev train, class, layout, timetable, stop and fare IDs and publishing behavior', async () => {
    const fixture = fakeApp();
    await seedCatalog(fixture.app);
    await seedCatalog(fixture.app);

    const ids = (name: string) => fixture.rows(name).map((row) => row.id);
    expect(ids('TrainTypeEntity')).toEqual([
      '00000000-0000-4000-8000-000000000101',
    ]);
    expect(ids('TravelClassEntity')).toEqual([
      '00000000-0000-4000-8000-000000000111',
      '00000000-0000-4000-8000-000000000112',
    ]);
    expect(ids('CoachLayoutEntity')).toEqual([
      '00000000-0000-4000-8000-000000000121',
      '00000000-0000-4000-8000-000000000122',
    ]);
    expect(ids('TrainEntity')).toEqual([
      '00000000-0000-4000-8000-000000000131',
    ]);
    expect(ids('TrainCoachEntity')).toEqual([
      '00000000-0000-4000-8000-000000000141',
      '00000000-0000-4000-8000-000000000142',
    ]);
    expect(fixture.rows('TimetableEntity')).toMatchObject([
      {
        id: '00000000-0000-4000-8000-000000000201',
        status: 'published',
        version: 1,
      },
    ]);
    expect(fixture.repository('TimetableEntity').save).toHaveBeenCalledTimes(1);
    expect(
      fixture.rows('TimetableStopEntity').map((row) => ({
        id: row.id,
        station: row.station,
        stationId: row.stationId,
      })),
    ).toEqual(
      Object.values(CATALOG_STATION_IDS).map((stationId, index) => ({
        id: `00000000-0000-4000-8000-00000000021${index + 1}`,
        station: { id: stationId },
        stationId,
      })),
    );
    expect(
      fixture.rows('FareEntity').map((row) => ({
        id: row.id,
        origin: row.originStationId,
        destination: row.destinationStationId,
        amount: row.amountPiastres,
      })),
    ).toEqual(
      [
        [CATALOG_STATION_IDS.cairo, CATALOG_STATION_IDS.giza, 5000],
        [CATALOG_STATION_IDS.cairo, CATALOG_STATION_IDS.beniSuef, 15000],
        [CATALOG_STATION_IDS.giza, CATALOG_STATION_IDS.beniSuef, 10000],
        [CATALOG_STATION_IDS.cairo, CATALOG_STATION_IDS.giza, 3500],
        [CATALOG_STATION_IDS.cairo, CATALOG_STATION_IDS.beniSuef, 10000],
        [CATALOG_STATION_IDS.giza, CATALOG_STATION_IDS.beniSuef, 7000],
      ].map(([origin, destination, amount], index) => ({
        id: `00000000-0000-4000-8000-00000000030${index + 1}`,
        origin,
        destination,
        amount,
      })),
    );
    expect(fixture.publishTimetable).toHaveBeenNthCalledWith(
      1,
      '00000000-0000-4000-8000-000000000201',
    );
    expect(fixture.publishTimetable).toHaveBeenCalledTimes(2);
  });

  for (const [label, main] of [
    ['stations', stationsMain],
    ['catalog', catalogMain],
  ] as const) {
    for (const fail of [false, true]) {
      it(`${label} CLI disables background jobs, closes its app and restores settings on ${fail ? 'failure' : 'success'}`, async () => {
        vi.stubEnv('OUTBOX_RELAY_ENABLED', 'true');
        vi.stubEnv('TRIP_GENERATION_ENABLED', 'true');
        vi.spyOn(console, 'log').mockImplementation(() => {});
        const fixture = fakeApp({
          commitError: fail ? new Error('commit failed') : undefined,
        });
        const expectJobsDisabled = () => {
          expect(process.env.OUTBOX_RELAY_ENABLED).toBe('false');
          expect(process.env.TRIP_GENERATION_ENABLED).toBe('false');
        };
        bootstrap.mockImplementation(async (module: unknown) => {
          expect(module).toBe(CatalogModule);
          expectJobsDisabled();
          return fixture.app;
        });
        fixture.close.mockImplementation(async () => {
          expectJobsDisabled();
          fixture.events.push('close');
        });

        if (fail) await expect(main()).rejects.toThrow('commit failed');
        else await main();

        expect(bootstrap).toHaveBeenCalledTimes(1);
        expect(fixture.close).toHaveBeenCalledTimes(1);
        expect(fixture.events.at(-1)).toBe('close');
        expect(process.env.OUTBOX_RELAY_ENABLED).toBe('true');
        expect(process.env.TRIP_GENERATION_ENABLED).toBe('true');
      });
    }
  }
});
