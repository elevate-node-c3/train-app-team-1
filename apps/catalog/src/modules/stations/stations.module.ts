import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { GovernorateEntity } from './entities/governorate.entity.js';
import { CityEntity } from './entities/city.entity.js';
import { StationEntity } from './entities/station.entity.js';
import { StationsRepository } from './stations.repository.js';
import { StationsService } from './stations.service.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      GovernorateEntity,
      CityEntity,
      StationEntity,
    ]),
  ],
  providers: [StationsRepository, StationsService],
  exports: [StationsRepository, StationsService],
})
export class StationsModule {}
