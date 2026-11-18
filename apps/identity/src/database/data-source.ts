import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { databaseUrlFromEnv } from '@app/common/config/database-url.js';
import { migrations } from './migrations/index.js';
import { HoldPassengerTripKeyEntity } from '../modules/auth/entities/hold-passenger-trip-key.entity.js';

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
  entities: [HoldPassengerTripKeyEntity],
  migrations,
});
