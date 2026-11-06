import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { CatalogReferenceRepository } from './catalog-reference.repository.js';
import { DatedTripEntity } from './entities/dated-trip.entity.js';
import { TripStopEntity } from './entities/trip-stop.entity.js';
import { SeatAvailabilityService } from './seat-availability.service.js';
import { TripSearchRepository } from './trip-search.repository.js';
import { TripSearchService } from './trip-search.service.js';
import { TripsGrpcController } from './trips.grpc.controller.js';

/**
 * One-way trip search.
 *
 * `CacheAsideService` is not listed: it comes from the global `RedisModule`,
 * so search takes a dependency on caching without taking one on ioredis.
 */
@Module({
  imports: [TypeOrmModule.forFeature([DatedTripEntity, TripStopEntity])],
  controllers: [TripsGrpcController],
  providers: [
    TripSearchRepository,
    CatalogReferenceRepository,
    SeatAvailabilityService,
    TripSearchService,
  ],
  exports: [TripSearchService],
})
export class TripsModule {}
