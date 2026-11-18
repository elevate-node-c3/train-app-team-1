import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { databaseUrlFromEnv } from '@app/common/config/database-url.js';
import { migrations } from './migrations/index.js';

/**
 * CLI only; the service runs these migrations during startup.
 * Run: npm run migration:run -- apps/notification/src/database/data-source.ts
 */
export default new DataSource({
  type: 'postgres',
  url: databaseUrlFromEnv(),
  synchronize: false,
  migrations,
});
