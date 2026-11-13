import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { databaseUrlFromEnv } from '../config/database-settings.js';

import { migrations } from './migrations/index.js';

/**
 * CLI connection. The service uses createTypeOrmAsyncOptions and
 * MigrationRunnerService with manualInitialization to initialize each DataSource
 * only once per process.
 */
export default new DataSource({
  type: 'postgres',
  url: databaseUrlFromEnv(),
  synchronize: false,
  entities: [],
  migrations,
});
