import { readFileSync } from 'node:fs';
import {
  createTypeOrmAsyncOptions,
  DataSourceInitializer,
  MigrationRunnerService,
} from '@app/common';
import type { DataSource } from 'typeorm';

/**
 * `manualInitialization: true` means Nest never connects the DataSource, so
 * `migrationsRun: true` never fires and schema changes need an explicit runner.
 * These tests pin the three things that make that runner safe: it does not
 * change the options the five services without migrations receive, it holds an
 * advisory lock across the run so two booting instances cannot both migrate,
 * and it releases that lock even when migrating fails.
 */

type FakeQueryRunner = {
  calls: string[];
  connect: () => Promise<void>;
  query: (sql: string) => Promise<unknown>;
  release: () => Promise<void>;
};

function fakeDataSource(options: {
  migrations?: unknown[];
  runMigrations?: () => Promise<{ name: string }[]>;
  isInitialized?: boolean;
  onUnlockThrow?: boolean;
}): { dataSource: DataSource; runner: FakeQueryRunner } {
  const runner: FakeQueryRunner = {
    calls: [],
    connect: async () => {
      runner.calls.push('connect');
    },
    query: async (sql: string) => {
      if (sql.includes('pg_advisory_unlock')) {
        runner.calls.push('unlock');
        if (options.onUnlockThrow) throw new Error('unlock exploded');
        return [{ pg_advisory_unlock: true }];
      }
      if (sql.includes('pg_advisory_lock')) {
        runner.calls.push('lock');
        return [{ pg_advisory_lock: '' }];
      }
      runner.calls.push(`query:${sql}`);
      return [];
    },
    release: async () => {
      runner.calls.push('release');
    },
  };

  const dataSource = {
    isInitialized: options.isInitialized ?? true,
    migrations: options.migrations ?? [{ name: 'CreateThing' }],
    initialize: async () => {
      runner.calls.push('initialize');
      return dataSource;
    },
    createQueryRunner: () => runner,
    runMigrations:
      options.runMigrations ??
      (async () => {
        runner.calls.push('runMigrations');
        return [{ name: 'CreateThing' }];
      }),
  } as unknown as DataSource;

  return { dataSource, runner };
}

describe('Migration infrastructure (§2.1)', () => {
  describe('createTypeOrmAsyncOptions', () => {
    // The five services that own no migrations must receive exactly what they
    // received before the parameter existed, or adding migrations to identity
    // silently changes how every other service connects.
    it('is unchanged for a service that passes no migrations', () => {
      const factory = createTypeOrmAsyncOptions().useFactory as () => Record<
        string,
        unknown
      >;
      const options = factory();

      expect(options).toEqual({
        name: undefined,
        type: 'postgres',
        url: process.env.DATABASE_URL || 'postgres://localhost:5432/postgres',
        autoLoadEntities: true,
        synchronize: false,
        manualInitialization: true,
        extra: { connectionTimeoutMillis: 5000 },
      });
      expect('migrations' in options).toBe(false);
    });

    it('passes migrations through without disturbing the rest', () => {
      class CreateThing {}
      const factory = createTypeOrmAsyncOptions(undefined, {
        migrations: [CreateThing],
      }).useFactory as () => Record<string, unknown>;
      const options = factory();

      expect(options.migrations).toEqual([CreateThing]);
      // synchronize stays off: schema changes are hand-written migrations.
      expect(options.synchronize).toBe(false);
      expect(options.manualInitialization).toBe(true);
    });
  });

  describe('DataSourceInitializer', () => {
    // There must be exactly one in-flight initialize(): two callers racing
    // throws CannotConnectAlreadyConnectedError, and the readiness probe, the
    // unit of work and the migration runner all connect lazily.
    it('initializes once when several callers arrive together', async () => {
      let initializeCount = 0;
      let resolveInit: () => void = () => {};
      const pending = new Promise<void>((resolve) => {
        resolveInit = resolve;
      });
      const dataSource = {
        isInitialized: false,
        initialize: async () => {
          initializeCount += 1;
          await pending;
          return dataSource;
        },
      } as unknown as DataSource;

      const initializer = new DataSourceInitializer(dataSource);
      const all = Promise.all([
        initializer.ensureInitialized(),
        initializer.ensureInitialized(),
        initializer.ensureInitialized(),
      ]);
      resolveInit();
      await all;

      expect(initializeCount).toBe(1);
    });

    // A Postgres outage at boot must not be cached as permanent — the platform
    // degrades and recovers rather than requiring a restart.
    it('retries after a failed attempt instead of caching the rejection', async () => {
      let attempts = 0;
      const dataSource = {
        isInitialized: false,
        initialize: async () => {
          attempts += 1;
          if (attempts === 1) throw new Error('ECONNREFUSED');
          return dataSource;
        },
      } as unknown as DataSource;

      const initializer = new DataSourceInitializer(dataSource);
      await expect(initializer.ensureInitialized()).rejects.toThrow(
        'ECONNREFUSED',
      );
      await expect(initializer.ensureInitialized()).resolves.toBeDefined();
      expect(attempts).toBe(2);
    });

    it('reports when no database is configured', () => {
      expect(new DataSourceInitializer().isConfigured).toBe(false);
      expect(
        new DataSourceInitializer({} as unknown as DataSource).isConfigured,
      ).toBe(true);
    });
  });

  describe('MigrationRunnerService', () => {
    it('holds an advisory lock across the run and releases it after', async () => {
      const { dataSource, runner } = fakeDataSource({});
      const service = new MigrationRunnerService(
        new DataSourceInitializer(dataSource),
      );

      await service.run();

      // Order is the correctness property: locking after migrating, or
      // unlocking before, would let two booting instances migrate at once.
      expect(runner.calls).toEqual([
        'connect',
        'lock',
        'runMigrations',
        'unlock',
        'release',
      ]);
      expect(service.hasCompleted).toBe(true);
    });

    it('releases the lock when migrating fails, and surfaces the failure', async () => {
      const { dataSource, runner } = fakeDataSource({
        runMigrations: async () => {
          throw new Error('relation already exists');
        },
      });
      const service = new MigrationRunnerService(
        new DataSourceInitializer(dataSource),
      );

      await expect(service.run()).rejects.toThrow('relation already exists');

      // Without the unlock a crashed migration would leave the key held for
      // the life of the connection and block every other instance.
      expect(runner.calls).toEqual(['connect', 'lock', 'unlock', 'release']);
      expect(service.hasCompleted).toBe(false);
    });

    it('does not let a failing unlock mask the migration error', async () => {
      const { dataSource } = fakeDataSource({
        onUnlockThrow: true,
        runMigrations: async () => {
          throw new Error('the real problem');
        },
      });
      const service = new MigrationRunnerService(
        new DataSourceInitializer(dataSource),
      );

      await expect(service.run()).rejects.toThrow('the real problem');
    });

    it('takes no lock and opens no connection when there are no migrations', async () => {
      const { dataSource, runner } = fakeDataSource({ migrations: [] });
      const service = new MigrationRunnerService(
        new DataSourceInitializer(dataSource),
      );

      await service.run();

      expect(runner.calls).toEqual([]);
      expect(service.hasCompleted).toBe(true);
    });

    // Boot must survive Postgres being unreachable: readiness already reports
    // the database as not ready, which is a better signal than a crash loop.
    it('logs rather than throws when bootstrap cannot reach the database', async () => {
      const dataSource = {
        isInitialized: false,
        initialize: async () => {
          throw new Error('ECONNREFUSED');
        },
      } as unknown as DataSource;
      const service = new MigrationRunnerService(
        new DataSourceInitializer(dataSource),
      );

      await expect(service.onApplicationBootstrap()).resolves.toBeUndefined();
      expect(service.hasCompleted).toBe(false);
    });

    it('does nothing at bootstrap in a service with no database', async () => {
      const service = new MigrationRunnerService(new DataSourceInitializer());
      await expect(service.onApplicationBootstrap()).resolves.toBeUndefined();
    });
  });

  describe('migration scripts', () => {
    it('exposes run, show and revert against an explicit data source', () => {
      const pkg = JSON.parse(readFileSync('package.json', 'utf8'));

      // `-d` is left without a value on purpose: the caller appends the data
      // source path, because each service owns its own migrations and there is
      // no single repo-wide data source to default to.
      //   npm run migration:show -- apps/identity/src/database/data-source.ts
      for (const command of [
        'migration:run',
        'migration:show',
        'migration:revert',
      ]) {
        expect(pkg.scripts[command]).toBe(`typeorm-ts-node-esm ${command} -d`);
      }

      // migration:generate is deliberately absent — migrations here are
      // hand-written, and a generated one would not match the reviewed DDL.
      expect(pkg.scripts['migration:generate']).toBeUndefined();
    });
  });
});
