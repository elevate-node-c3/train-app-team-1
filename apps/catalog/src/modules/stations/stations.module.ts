import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OutboxModule } from '@app/messaging/outbox/outbox.module.js';
import { CityEntity } from './entities/city.entity.js';
import { GovernorateEntity } from './entities/governorate.entity.js';
import { StationEntity } from './entities/station.entity.js';
import { StationsGrpcController } from './controllers/stations.grpc.controller.js';

import { StationsRepository } from './stations.repository.js';
import { StationsService } from './services/stations.service.js';
import { StationsManagementService } from './services/stations-management.service.js';
import { StationsManagementGrpcController } from './controllers/stations-management.grpc.controller.js';
import { OperationsRequestRepository } from '../operations/repositories/operations-request.repository.js';
import { OperationsRequestEntity } from '../operations/entities/operations-request.entity.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      GovernorateEntity,
      CityEntity,
      StationEntity,
      OperationsRequestEntity,
    ]),
    OutboxModule,
  ],
  controllers: [StationsGrpcController, StationsManagementGrpcController],
  providers: [
    StationsRepository,
    StationsService,
    StationsManagementService,
    OperationsRequestRepository,
  ],
  exports: [StationsRepository, StationsService, StationsManagementService],
})
export class StationsModule {}
