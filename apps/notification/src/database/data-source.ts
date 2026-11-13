import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { databaseUrlFromEnv } from '../config/database-settings.js';
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
