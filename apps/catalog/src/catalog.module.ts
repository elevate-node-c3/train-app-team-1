import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import {
  CommonModule,
  createTypeOrmAsyncOptions,
  MigrationModule,
} from '@app/common';

import { MessagingModule, OutboxModule } from '@app/messaging';

import { migrations } from './database/migrations/index.js';
import { ServiceInfoController } from './service-info.controller.js';

import { CatalogCacheModule } from './modules/cache/catalog-cache.module.js';
import { InvalidationModule } from './modules/invalidation/invalidation.module.js';
import { RecentSearchesModule } from './modules/recent-searches/recent-searches.module.js';
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
    CatalogCacheModule,
    StationsModule,
    TrainsModule,
    TimetablesModule,
    FaresModule,
    TripsModule,
    RecentSearchesModule,
    InvalidationModule,
    OutboxModule,
  ],
  controllers: [ServiceInfoController],
})
export class CatalogModule {}
