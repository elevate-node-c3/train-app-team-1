import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { databaseUrlFromEnv } from '../config/database-settings.js';
import { migrations } from './migrations/index.js';

/**
 * CLI and staff-seed connection:
 *   npm run migration:run -- apps/identity/src/database/data-source.ts
 *   npm run seed:staff
 *
 * The service uses its shared migration runner and initializes one DataSource once.
 */
export default new DataSource({
  type: 'postgres',
  url: databaseUrlFromEnv(),
  synchronize: false,
  migrations,
});
