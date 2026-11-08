import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { CatalogCacheModule } from '../cache/catalog-cache.module.js';
import { RecentSearchesModule } from '../recent-searches/recent-searches.module.js';

import { CatalogReferenceRepository } from './catalog-reference.repository.js';
import { DatedTripEntity } from './entities/dated-trip.entity.js';
import { TripStopEntity } from './entities/trip-stop.entity.js';
import { SeatAvailabilityService } from './seat-availability.service.js';
import { TripDayService } from './trip-day.service.js';
import { TripReturnSearchService } from './trip-return-search.service.js';
import { TripSearchRepository } from './trip-search.repository.js';
import { TripSearchService } from './trip-search.service.js';
import { TripStopsRepository } from './trip-stops.repository.js';
import { TripStopsService } from './trip-stops.service.js';
import { TripsGrpcController } from './trips.grpc.controller.js';

/**
 * Trip search: one way, the return leg of a round trip, and a trip's stops.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([DatedTripEntity, TripStopEntity]),
    CatalogCacheModule,
    RecentSearchesModule,
  ],
  controllers: [TripsGrpcController],
  providers: [
    TripSearchRepository,
    TripStopsRepository,
    CatalogReferenceRepository,
    SeatAvailabilityService,
    TripDayService,
    TripSearchService,
    TripReturnSearchService,
    TripStopsService,
  ],
  exports: [TripSearchService],
})
export class TripsModule {}
