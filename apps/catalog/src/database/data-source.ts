import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { databaseUrlFromEnv } from '../config/database-settings.js';
import { GovernorateEntity } from '../modules/stations/entities/governorate.entity.js';
import { CityEntity } from '../modules/stations/entities/city.entity.js';
import { StationEntity } from '../modules/stations/entities/station.entity.js';
import { migrations } from './migrations/index.js';
/**
 * The catalog database connection shared by the TypeORM CLI and the station
 * seed:
 *
 *   npm run migration:run -- apps/catalog/src/database/data-source.ts
 *
 * The running service uses `createTypeOrmAsyncOptions(undefined, { migrations })`
 * and the shared `MigrationRunnerService` instead, because one DataSource must
 * be initialized once per process (`manualInitialization: true`).
 */
export default new DataSource({
  type: 'postgres',
  url: databaseUrlFromEnv(),
  synchronize: false,
  entities: [GovernorateEntity, CityEntity, StationEntity],
  migrations,
});