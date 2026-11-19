import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
// Import directly to avoid a consumer-side cycle that leaves MessageRepublisher undefined.
import { OutboxModule } from '@app/messaging/outbox/outbox.module.js';

import { CatalogCacheModule } from '../cache/catalog-cache.module.js';
import { RecentSearchesModule } from '../recent-searches/recent-searches.module.js';
import { FareEntity } from '../fares/entities/fare.entity.js';
import { TimetableEntity } from '../timetables/entities/timetable.entity.js';
import { TimetableStopEntity } from '../timetables/entities/timetable-stop.entity.js';
import { TrainEntity } from '../trains/entities/train.entity.js';
import { TrainCoachEntity } from '../trains/entities/train-coach.entity.js';

import { BookingQuoteService } from './services/booking-quote.service.js';
import { CatalogReferenceRepository } from './repositories/catalog-reference.repository.js';
import { DatedTripEntity } from './entities/dated-trip.entity.js';
import { TripStopEntity } from './entities/trip-stop.entity.js';
import { SeatAvailabilityService } from './services/seat-availability.service.js';
import { TripDayService } from './services/trip-day.service.js';
import { TripReturnSearchService } from './services/trip-return-search.service.js';
import { TripSearchRepository } from './repositories/trip-search.repository.js';
import { TripSearchService } from './services/trip-search.service.js';
import { TripStopsRepository } from './repositories/trip-stops.repository.js';
import { TripStopsService } from './services/trip-stops.service.js';
import { TripsGrpcController } from './trips.grpc.controller.js';
import { TripsService } from './services/trips.service.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      DatedTripEntity,
      TripStopEntity,
      TrainEntity,
      TrainCoachEntity,
      TimetableEntity,
      TimetableStopEntity,
      FareEntity,
    ]),
    CatalogCacheModule,
    RecentSearchesModule,
    OutboxModule,
  ],
  controllers: [TripsGrpcController],
  providers: [
    BookingQuoteService,
    TripSearchRepository,
    TripStopsRepository,
    CatalogReferenceRepository,
    SeatAvailabilityService,
    TripDayService,
    TripSearchService,
    TripReturnSearchService,
    TripStopsService,
    TripsService,
  ],
  exports: [TripSearchService, TripStopsService, TripsService],
})
export class TripsModule {}
