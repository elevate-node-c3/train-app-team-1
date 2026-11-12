import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { TypeOrmModule } from '@nestjs/typeorm';
import { getInventoryProtoPath, INVENTORY_PACKAGE_NAME } from '@app/contracts';
// Deep import on purpose, as `trips.module.ts` does: the `@app/messaging`
// barrel pulls the consumer side in too, and the cycle that creates leaves an
// injected dependency undefined at runtime.
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
import { OperationsRequestRepository } from './operations-request.repository.js';
import { TimetablePublishRepository } from './timetable-publish.repository.js';
import { TimetablePublishService } from './timetable-publish.service.js';
import { TimetableVersionService } from './timetable-version.service.js';

/**
 * Must match inventory's own server loader options, or a `repeated` field
 * arrives in an unexpected shape -- see inventory's `main.ts`.
 *
 * `defaults: true` deviates from catalog's and the gateway's catalog client
 * (`apps/gateway/src/modules/catalog/catalog.module.ts`), which both omit
 * it deliberately. That reasoning does not transfer here: `inventory.proto`
 * is the first proto in this codebase with a plain scalar whose ordinary
 * value is zero (`soldCount`, `heldCount`). proto3 does not serialize a
 * zero-valued scalar, so without `defaults: true` an honest "nothing sold"
 * answer decodes with the counts *absent*, not zero -- which is exactly the
 * silence this task exists to tell apart from a real zero. Do not "unify"
 * this with the other two clients' loader options.
 */
export const INVENTORY_GRPC_LOADER_OPTIONS = {
  enums: String,
  arrays: true,
  defaults: true,
} as const;

/**
 * The operator's side of the catalogue (TA-20): publishing a timetable
 * version, the audit trail BR-52 requires of it, the idempotency keys that
 * make a retried publish safe, and the seam that answers the one question a
 * publish must never guess at -- has this dated trip already sold or held
 * seats.
 *
 * Every entity any of those providers reads is registered here. `forFeature`
 * is per-module, so an entity another module registered is not injectable in
 * this one, and a missing registration fails at *runtime* rather than at
 * build time.
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
