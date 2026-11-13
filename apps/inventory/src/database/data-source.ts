import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { databaseUrlFromEnv } from '../config/database-settings.js';

import { migrations } from './migrations/index.js';
import { InventoryTripEntity } from '../modules/seats/entities/inventory-trip.entity.js';
import { TripStopEntity } from '../modules/seats/entities/trip-stop.entity.js';
import { TripCoachEntity } from '../modules/seats/entities/trip-coach.entity.js';
import { TripSeatEntity } from '../modules/seats/entities/trip-seat.entity.js';

/**
 * CLI connection. The service uses createTypeOrmAsyncOptions and
 * MigrationRunnerService with manualInitialization to initialize each DataSource
 * only once per process.
 */
export default new DataSource({
  type: 'postgres',
  url: databaseUrlFromEnv(),
  synchronize: false,
  entities: [InventoryTripEntity, TripStopEntity, TripCoachEntity, TripSeatEntity],
  migrations,
});
