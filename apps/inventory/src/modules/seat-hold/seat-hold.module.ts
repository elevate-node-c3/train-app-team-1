import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OutboxModule } from '@app/messaging';
import { MigrationModule } from '@app/common';
import { SeatHoldGroupEntity } from './entities/seat-hold-group.entity.js';
import { SeatHoldOwnerGuardEntity } from './entities/seat-hold-owner-guard.entity.js';
import { SeatHoldPassengerEntity } from './entities/seat-hold-passenger.entity.js';
import { SeatHoldLegEntity } from './entities/seat-hold-leg.entity.js';
import { SeatHoldAssignmentEntity } from './entities/seat-hold-assignment.entity.js';
import { SeatHoldGrpcController } from './seat-hold.grpc.controller.js';
import { HoldCoreRepository } from './hold-core.repository.js';
import { HoldCoreService } from './services/hold-core.service.js';
import { HoldSettlementService } from './services/hold-settlement.service.js';
import { HoldExpiryWorker } from './hold-expiry.worker.js';
import { HoldCreationGuard, HoldServiceGuard } from './hold-access.guard.js';
import { SeatsModule } from '../seats/seats.module.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      SeatHoldGroupEntity,
      SeatHoldOwnerGuardEntity,
      SeatHoldPassengerEntity,
      SeatHoldLegEntity,
      SeatHoldAssignmentEntity,
    ]),
    OutboxModule,
    MigrationModule,
    SeatsModule,
  ],
  controllers: [SeatHoldGrpcController],
  providers: [
    HoldCoreRepository,
    HoldCoreService,
    HoldSettlementService,
    HoldExpiryWorker,
    HoldCreationGuard,
    HoldServiceGuard,
  ],
  exports: [HoldCoreService, HoldSettlementService],
})
export class SeatHoldModule {}
