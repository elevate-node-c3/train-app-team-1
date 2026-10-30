import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { TrainTypeEntity } from './entities/train-type.entity.js';
import { TrainEntity } from './entities/train.entity.js';
import { TravelClassEntity } from './entities/travel-class.entity.js';
import { CoachLayoutEntity } from './entities/coach-layout.entity.js';
import { TrainCoachEntity } from './entities/train-coach.entity.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      TrainTypeEntity,
      TrainEntity,
      TravelClassEntity,
      CoachLayoutEntity,
      TrainCoachEntity,
    ]),
  ],
})
export class TrainsModule {}