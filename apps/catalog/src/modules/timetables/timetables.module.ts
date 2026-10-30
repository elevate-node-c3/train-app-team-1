import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { TimetableEntity } from './entities/timetable.entity.js';
import { TimetableStopEntity } from './entities/timetable-stop.entity.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      TimetableEntity,
      TimetableStopEntity,
    ]),
  ],
})
export class TimetablesModule {}