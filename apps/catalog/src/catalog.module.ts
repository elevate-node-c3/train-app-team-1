import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import {
  CommonModule,
  createTypeOrmAsyncOptions,
  MigrationModule,
} from '@app/common';

import { MessagingModule } from '@app/messaging';

import { migrations } from './database/migrations/index.js';
import { ServiceInfoController } from './service-info.controller.js';

import { StationsModule } from './modules/stations/stations.module.js';
import { TrainsModule } from './modules/trains/trains.module.js';
import { TimetablesModule } from './modules/timetables/timetables.module.js';
import { FaresModule } from './modules/fares/fares.module.js';
import { TripsModule } from './modules/trips/trips.module.js';

@Module({
  imports: [
    TypeOrmModule.forRootAsync(
      createTypeOrmAsyncOptions(undefined, { migrations }),
    ),
    CommonModule,
    MessagingModule,
    MigrationModule,
    StationsModule,
    TrainsModule,
    TimetablesModule,
    FaresModule,
    TripsModule,
  ],
  controllers: [ServiceInfoController],
})
export class CatalogModule {}