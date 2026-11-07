import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

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
 *
 * `CacheAsideService` is not listed: it comes from the global `RedisModule`,
 * so search takes a dependency on caching without taking one on ioredis.
 *
 * `TripDayService` is the seam both search legs read a day through, which is
 * what makes the return list share the outbound's cache key rather than
 * inventing one of its own.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([DatedTripEntity, TripStopEntity]),
    // Search records the search it just answered; recent searches own that
    // table, so this is a dependency rather than a second writer.
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
