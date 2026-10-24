import { TypeOrmModuleAsyncOptions } from '@nestjs/typeorm';
import type { DataSourceOptions } from 'typeorm';

export interface TypeOrmExtraOptions {
  /**
   * Hand-written migration classes, in the order they must run. Required for
   * `MigrationRunnerService` to have anything to apply — `migrationsRun` is
   * not used, because it only fires inside `initialize()` and
   * `manualInitialization: true` means Nest never calls it.
   */
  migrations?: DataSourceOptions['migrations'];
}

export function createTypeOrmAsyncOptions(
  connectionName?: string,
  extra: TypeOrmExtraOptions = {},
): TypeOrmModuleAsyncOptions {
  return {
    name: connectionName,
    useFactory: () => ({
      name: connectionName,
      type: 'postgres',
      url: process.env.DATABASE_URL || 'postgres://localhost:5432/postgres',
      autoLoadEntities: true,
      synchronize: false,
      manualInitialization: true,
      extra: {
        connectionTimeoutMillis: 5000,
      },
      // Spread rather than assigned, so a service without migrations gets the
      // same options object it did before this parameter existed. An explicit
      // `migrations: undefined` would also be harmless to TypeORM but makes
      // the no-argument call impossible to assert on.
      ...(extra.migrations ? { migrations: extra.migrations } : {}),
    }),
  };
}
