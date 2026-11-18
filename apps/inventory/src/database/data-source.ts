
import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { databaseUrlFromEnv } from '@app/common/config/database-url.js';
import { migrations } from './migrations/index.js';
import { InventoryTripEntity } from '../modules/seats/entities/inventory-trip.entity.js';
import { TripStopEntity } from '../modules/seats/entities/trip-stop.entity.js';
import { TripCoachEntity } from '../modules/seats/entities/trip-coach.entity.js';
import { TripSeatEntity } from '../modules/seats/entities/trip-seat.entity.js';
import { SeatOccupationEntity } from '../modules/seats/entities/seat-occupation.entity.js';
import { SeatHoldGroupEntity } from '../modules/seat-hold/entities/seat-hold-group.entity.js';
import { SeatHoldOwnerGuardEntity } from '../modules/seat-hold/entities/seat-hold-owner-guard.entity.js';
import { SeatHoldPassengerEntity } from '../modules/seat-hold/entities/seat-hold-passenger.entity.js';
import { SeatHoldLegEntity } from '../modules/seat-hold/entities/seat-hold-leg.entity.js';
import { SeatHoldAssignmentEntity } from '../modules/seat-hold/entities/seat-hold-assignment.entity.js';

/**
 * CLI connection. The service uses createTypeOrmAsyncOptions and
 * MigrationRunnerService with manualInitialization to initialize each DataSource
 * only once per process.
 */
export default new DataSource({
  type: 'postgres',
  url: databaseUrlFromEnv(),
  synchronize: false,
  entities: [
    InventoryTripEntity,
    TripStopEntity,
    TripCoachEntity,
    TripSeatEntity,
    SeatOccupationEntity,
    SeatHoldGroupEntity,
    SeatHoldOwnerGuardEntity,
    SeatHoldPassengerEntity,
    SeatHoldLegEntity,
    SeatHoldAssignmentEntity,
  ],
  migrations,
});
