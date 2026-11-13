import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { TypeOrmModule } from '@nestjs/typeorm';
import { getInventoryProtoPath, INVENTORY_PACKAGE_NAME } from '@app/contracts';
// Import directly to avoid a consumer-side barrel cycle and undefined injection.
import { OutboxModule } from '@app/messaging/outbox/outbox.module.js';

import { inventoryGrpcUrl } from '../../config/operations-settings.js';
import { FareEntity } from '../fares/entities/fare.entity.js';
import { StationEntity } from '../stations/entities/station.entity.js';
import { TimetableEntity } from '../timetables/entities/timetable.entity.js';
import { TimetableStopEntity } from '../timetables/entities/timetable-stop.entity.js';
import { CoachLayoutEntity } from '../trains/entities/coach-layout.entity.js';
import { TrainEntity } from '../trains/entities/train.entity.js';
import { TrainCoachEntity } from '../trains/entities/train-coach.entity.js';
import { TravelClassEntity } from '../trains/entities/travel-class.entity.js';
import { DatedTripEntity } from '../trips/entities/dated-trip.entity.js';
import { TripStopEntity } from '../trips/entities/trip-stop.entity.js';
import { TripsModule } from '../trips/trips.module.js';
import { OperationsAuditEntity } from './entities/operations-audit.entity.js';
import { OperationsRequestEntity } from './entities/operations-request.entity.js';
import {
  INVENTORY_GRPC_CLIENT,
  InventorySeatUsageClient,
} from './inventory-seat-usage.grpc.client.js';
import { FareChangeRepository } from './fare-change.repository.js';
import { FareChangeService } from './fare-change.service.js';
import { OperationsAuditRepository } from './operations-audit.repository.js';
import { OperationsAuditService } from './operations-audit.service.js';
import { OperationsGrpcController } from './operations.grpc.controller.js';
import { OperationsRequestRepository } from './operations-request.repository.js';
import { TimetablePublishRepository } from './timetable-publish.repository.js';
import { TimetablePublishService } from './timetable-publish.service.js';
import { TimetableVersionService } from './timetable-version.service.js';

/**
 * Match inventory's server loader, including repeated-field shapes.
 * Keep defaults: true: proto3 omits zero soldCount/heldCount scalars, which must
 * decode as zero rather than unanswered counts. Catalog and gateway intentionally
 * omit defaults for their different schemas; do not unify these options.
 */
export const INVENTORY_GRPC_LOADER_OPTIONS = {
  enums: String,
  arrays: true,
  defaults: true,
} as const;

/**
 * Register every provider's entities locally: forFeature registrations do not
 * cross module boundaries, and omissions fail at runtime.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      TimetableEntity,
      TimetableStopEntity,
      TrainEntity,
      TrainCoachEntity,
      TravelClassEntity,
      CoachLayoutEntity,
      StationEntity,
      FareEntity,
      DatedTripEntity,
      TripStopEntity,
      OperationsAuditEntity,
      OperationsRequestEntity,
    ]),
    TripsModule,
    OutboxModule,
    ClientsModule.registerAsync([
      {
        name: INVENTORY_GRPC_CLIENT,
        useFactory: () => ({
          transport: Transport.GRPC,
          options: {
            package: INVENTORY_PACKAGE_NAME,
            protoPath: getInventoryProtoPath(),
            url: inventoryGrpcUrl(),
            loader: INVENTORY_GRPC_LOADER_OPTIONS,
          },
        }),
      },
    ]),
  ],
  controllers: [OperationsGrpcController],
  providers: [
    InventorySeatUsageClient,
    TimetableVersionService,
    OperationsAuditRepository,
    OperationsAuditService,
    OperationsRequestRepository,
    TimetablePublishRepository,
    TimetablePublishService,
    FareChangeRepository,
    FareChangeService,
  ],
  exports: [
    InventorySeatUsageClient,
    TimetableVersionService,
    OperationsAuditService,
    TimetablePublishService,
    FareChangeService,
  ],
})
export class OperationsModule {}
