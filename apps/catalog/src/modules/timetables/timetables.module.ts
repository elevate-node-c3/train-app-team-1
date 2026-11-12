import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { TimetableEntity } from './entities/timetable.entity.js';
import { TimetableStopEntity } from './entities/timetable-stop.entity.js';
import { TimetablesService } from './timetables.service.js';
import { TripsModule } from '../trips/trips.module.js';
import { OutboxModule } from '@app/messaging';

@Module({
  imports: [
    TypeOrmModule.forFeature([TimetableEntity, TimetableStopEntity]),
    TripsModule,
    OutboxModule,
  ],

  providers: [TimetablesService],
  exports: [TimetablesService],
})
export class TimetablesModule {}
