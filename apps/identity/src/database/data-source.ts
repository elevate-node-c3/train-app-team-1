import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { migrations } from './migrations/index.js';

/**
 * The identity database connection shared by the TypeORM CLI and the staff
 * seed:
 *
 *   npm run migration:run -- apps/identity/src/database/data-source.ts
 *   npm run seed:staff
 *
 * The running service uses `createTypeOrmAsyncOptions(undefined, { migrations })`
 * and the shared `MigrationRunnerService` instead, because one DataSource must
 * be initialized once per process (`manualInitialization: true`).
 */
export default new DataSource({
  type: 'postgres',
  url:
    process.env.DATABASE_URL ??
    'postgres://identity:identity_dev@localhost:5432/identity',
  synchronize: false,
  migrations,
});
