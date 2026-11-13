import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { InventoryTripEntity } from './entities/inventory-trip.entity.js';
import { SeatOccupationEntity } from './entities/seat-occupation.entity.js';
import { TripCoachEntity } from './entities/trip-coach.entity.js';
import { TripSeatEntity } from './entities/trip-seat.entity.js';
import { TripStopEntity } from './entities/trip-stop.entity.js';
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
  ],
  providers: [SeatPlanRepository, AvailabilityRepository, AvailabilityService, SeatUsageRepository],
  exports: [SeatPlanRepository, AvailabilityRepository, AvailabilityService, SeatUsageRepository],
})
export class SeatsModule {}
