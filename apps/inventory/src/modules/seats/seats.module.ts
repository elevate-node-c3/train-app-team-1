import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OutboxModule } from '@app/messaging';

import { InventoryTripEntity } from './entities/inventory-trip.entity.js';
import { SeatOccupationEntity } from './entities/seat-occupation.entity.js';
import { TripCoachEntity } from './entities/trip-coach.entity.js';
import { TripSeatEntity } from './entities/trip-seat.entity.js';
import { TripStopEntity } from './entities/trip-stop.entity.js';
import { AvailabilityCountsRepository } from './availability-counts.repository.js';
import { AvailabilityPublisher } from './availability-publisher.service.js';
import { AvailabilityRepository } from './availability.repository.js';
import { AvailabilityService } from './availability.service.js';
import { SeatPlanRepository } from './seat-plan.repository.js';
import { SeatUsageRepository } from './seat-usage.repository.js';

/** Owns inventory's seat tables and the services that read and write them. */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      InventoryTripEntity,
      TripStopEntity,
      TripCoachEntity,
      TripSeatEntity,
      SeatOccupationEntity,
    ]),
    OutboxModule,
  ],
  providers: [
    SeatPlanRepository,
    AvailabilityRepository,
    AvailabilityService,
    AvailabilityCountsRepository,
    AvailabilityPublisher,
    SeatUsageRepository,
  ],
  exports: [
    SeatPlanRepository,
    AvailabilityRepository,
    AvailabilityService,
    AvailabilityCountsRepository,
    AvailabilityPublisher,
    SeatUsageRepository,
  ],
})
export class SeatsModule {}
