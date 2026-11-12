import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { databaseUrlFromEnv } from '../config/database-settings.js';

import { GovernorateEntity } from '../modules/stations/entities/governorate.entity.js';
import { CityEntity } from '../modules/stations/entities/city.entity.js';
import { StationEntity } from '../modules/stations/entities/station.entity.js';

import { TrainTypeEntity } from '../modules/trains/entities/train-type.entity.js';
import { TravelClassEntity } from '../modules/trains/entities/travel-class.entity.js';
import { CoachLayoutEntity } from '../modules/trains/entities/coach-layout.entity.js';
import { TrainEntity } from '../modules/trains/entities/train.entity.js';
import { TrainCoachEntity } from '../modules/trains/entities/train-coach.entity.js';

import { TimetableEntity } from '../modules/timetables/entities/timetable.entity.js';
import { TimetableStopEntity } from '../modules/timetables/entities/timetable-stop.entity.js';

import { FareEntity } from '../modules/fares/entities/fare.entity.js';

import { DatedTripEntity } from '../modules/trips/entities/dated-trip.entity.js';
import { TripStopEntity } from '../modules/trips/entities/trip-stop.entity.js';

import { migrations } from './migrations/index.js';

/**
 * CLI and seed connection. The service uses createTypeOrmAsyncOptions and
 * MigrationRunnerService with manualInitialization to initialize each DataSource
 * only once per process.
 */
export default new DataSource({
  type: 'postgres',
  url: databaseUrlFromEnv(),
  synchronize: false,
  entities: [
    GovernorateEntity,
    CityEntity,
    StationEntity,
    TrainTypeEntity,
    TravelClassEntity,
    CoachLayoutEntity,
    TrainEntity,
    TrainCoachEntity,
    TimetableEntity,
    TimetableStopEntity,
    FareEntity,
    DatedTripEntity,
    TripStopEntity,
  ],
  migrations,
});
