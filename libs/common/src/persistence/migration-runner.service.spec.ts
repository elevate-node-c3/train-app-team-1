import { readFileSync } from 'node:fs';
import {
  createTypeOrmAsyncOptions,
  DataSourceInitializer,
  MigrationRunnerService,
  SchemaReadinessGate,
} from '@app/common';
import type { DataSource } from 'typeorm';


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
        new SchemaReadinessGate(),
      );

      await service.run();

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
        new SchemaReadinessGate(),
      );

      await expect(service.run()).rejects.toThrow('relation already exists');

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
        new SchemaReadinessGate(),
      );

      await expect(service.run()).rejects.toThrow('the real problem');
    });

    it('takes no lock and opens no connection when there are no migrations', async () => {
      const { dataSource, runner } = fakeDataSource({ migrations: [] });
      const service = new MigrationRunnerService(
        new DataSourceInitializer(dataSource),
        new SchemaReadinessGate(),
      );

      await service.run();

      expect(runner.calls).toEqual([]);
      expect(service.hasCompleted).toBe(true);
    });

    it('logs rather than throws when bootstrap cannot reach the database', async () => {
      const dataSource = {
        isInitialized: false,
        initialize: async () => {
          throw new Error('ECONNREFUSED');
        },
      } as unknown as DataSource;
      const service = new MigrationRunnerService(
        new DataSourceInitializer(dataSource),
        new SchemaReadinessGate(),
      );

      await expect(service.onApplicationBootstrap()).resolves.toBeUndefined();
      expect(service.hasCompleted).toBe(false);
    });

    it('does nothing at bootstrap in a service with no database', async () => {
      const service = new MigrationRunnerService(
        new DataSourceInitializer(),
        new SchemaReadinessGate(),
      );
      await expect(service.onApplicationBootstrap()).resolves.toBeUndefined();
    });
  });

  describe('SchemaReadinessGate', () => {
    // Check without awaiting a closed gate, which would hang.
    async function isOpen(gate: SchemaReadinessGate): Promise<boolean> {
      let open = false;
      void gate.whenReady.then(() => {
        open = true;
      });
      await new Promise((resolve) => setImmediate(resolve));
      return open;
    }

    // Services without migrations need the gate to start open.
    it('is ready until a migration runner closes it', async () => {
      await expect(isOpen(new SchemaReadinessGate())).resolves.toBe(true);
    });

    it('is closed by constructing the runner, before any hook runs', async () => {
      const gate = new SchemaReadinessGate();
      const { dataSource } = fakeDataSource({});

      new MigrationRunnerService(new DataSourceInitializer(dataSource), gate);

      await expect(isOpen(gate)).resolves.toBe(false);
    });

    it('opens once migrations have been applied', async () => {
      const gate = new SchemaReadinessGate();
      const { dataSource } = fakeDataSource({});
      const service = new MigrationRunnerService(
        new DataSourceInitializer(dataSource),
        gate,
      );

      await service.onApplicationBootstrap();

      await expect(isOpen(gate)).resolves.toBe(true);
      expect(service.hasCompleted).toBe(true);
    });

    it('opens even when migrating fails', async () => {
      const gate = new SchemaReadinessGate();
      const { dataSource } = fakeDataSource({
        runMigrations: async () => {
          throw new Error('relation already exists');
        },
      });
      const service = new MigrationRunnerService(
        new DataSourceInitializer(dataSource),
        gate,
      );

      await service.onApplicationBootstrap();

      await expect(isOpen(gate)).resolves.toBe(true);
      expect(service.hasCompleted).toBe(false);
    });

    it('opens in a service that has a runner but no database', async () => {
      const gate = new SchemaReadinessGate();
      const service = new MigrationRunnerService(
        new DataSourceInitializer(),
        gate,
      );

      await service.onApplicationBootstrap();

      await expect(isOpen(gate)).resolves.toBe(true);
    });
  });

  describe('migration scripts', () => {
    it('exposes generate, run, show and revert against an explicit data source', () => {
      const pkg = JSON.parse(readFileSync('package.json', 'utf8'));

      // Pass the data source path after -d; each service owns its migrations.
      //   npm run migration:show -- apps/identity/src/database/data-source.ts
      expect(pkg.devDependencies.tsx).toBeDefined();
      for (const command of [
        'migration:generate',
        'migration:run',
        'migration:show',
        'migration:revert',
      ]) {
        expect(pkg.scripts[command]).toBe(
          `tsx node_modules/typeorm/cli.js ${command} -d`,
        );
      }

      // Runtime images have no sources or tsx; seeds must run from dist.
      expect(pkg.scripts['seed:staff']).toBe(
        'node dist/apps/identity/src/database/seeds/staff-accounts.seed.js',
      );
      for (const command of [
        'catalog:seed',
        'catalog:seed:search',
        'catalog:seed:today',
      ]) {
        expect(pkg.scripts[command]).toMatch(/^node dist\//);
      }

      // migration:generate takes the data source then the output path:
      //   npm run migration:generate -- apps/catalog/src/database/data-source.ts \
      //     apps/catalog/src/database/migrations/AddSomething
      // Review and edit generated SQL before committing it.
      expect(pkg.scripts['catalog:migration:generate']).toBe(
        'tsx node_modules/typeorm/cli.js migration:generate -d apps/catalog/src/database/data-source.ts',
      );
    });
  });
});
