import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { DatedTripEntity } from './entities/dated-trip.entity.js';
import { TripStopEntity } from './entities/trip-stop.entity.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      DatedTripEntity,
      TripStopEntity,
    ]),
  ],
})
export class TripsModule {}