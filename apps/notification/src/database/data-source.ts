import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { databaseUrlFromEnv } from '../config/database-settings.js';
import { migrations } from './migrations/index.js';

/**
 * Used by the TypeORM CLI only:
 *
 *   npm run migration:run -- apps/notification/src/database/data-source.ts
 *
 * The running service passes the same `migrations` array to
 * `createTypeOrmAsyncOptions()` and lets the shared `MigrationRunnerService`
 * apply it against the one DataSource the process owns.
 */
export default new DataSource({
  type: 'postgres',
  url: databaseUrlFromEnv(),
  synchronize: false,
  migrations,
});
