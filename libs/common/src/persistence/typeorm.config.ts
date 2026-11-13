import { TypeOrmModuleAsyncOptions } from '@nestjs/typeorm';
import type { DataSourceOptions } from 'typeorm';

export interface TypeOrmExtraOptions {
  /**
   * Ordered hand-written migrations, applied by MigrationRunnerService.
   * Nest uses manual initialization, so migrationsRun is not used.
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
      ...(extra.migrations ? { migrations: extra.migrations } : {}),
    }),
  };
}
