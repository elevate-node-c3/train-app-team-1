import { TypeOrmModuleAsyncOptions } from '@nestjs/typeorm';

export function createTypeOrmAsyncOptions(
  connectionName?: string,
): TypeOrmModuleAsyncOptions {
  return {
    name: connectionName,
    useFactory: () => ({
      name: connectionName,
      type: 'postgres',
      url: process.env.DATABASE_URL || 'postgres://localhost:5432/postgres',
      autoLoadEntities: true,
      // The schema follows the entities; there are no migrations.
      synchronize: true,
      manualInitialization: true,
      extra: {
        connectionTimeoutMillis: 5000,
      },
    }),
  };
}
