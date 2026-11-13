import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OutboxModule } from '@app/messaging/outbox/outbox.module.js';
import { CityEntity } from './entities/city.entity.js';
import { GovernorateEntity } from './entities/governorate.entity.js';
import { StationEntity } from './entities/station.entity.js';
import { StationsGrpcController } from './stations.grpc.controller.js';

import { StationsRepository } from './stations.repository.js';
import { StationsService } from './stations.service.js';
import { StationsManagementService } from './stations-management.service.js';
import { StationsManagementGrpcController } from './stations-management.grpc.controller.js';
import { OperationsRequestRepository } from '../operations/operations-request.repository.js';
import { OperationsRequestEntity } from '../operations/entities/operations-request.entity.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([GovernorateEntity, CityEntity, StationEntity, OperationsRequestEntity]),
    OutboxModule,
  ],
  controllers: [StationsGrpcController, StationsManagementGrpcController],
  providers: [StationsRepository, StationsService, StationsManagementService, OperationsRequestRepository],
  exports: [StationsRepository, StationsService, StationsManagementService],
})
export class StationsModule {}
