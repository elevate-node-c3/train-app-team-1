import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { TypeOrmModule } from '@nestjs/typeorm';
import { getInventoryProtoPath, INVENTORY_PACKAGE_NAME } from '@app/contracts';

import { inventoryGrpcUrl } from '../../config/operations-settings.js';
import { TimetableEntity } from '../timetables/entities/timetable.entity.js';
import { OperationsAuditEntity } from './entities/operations-audit.entity.js';
import {
  INVENTORY_GRPC_CLIENT,
  InventorySeatUsageClient,
} from './inventory-seat-usage.grpc.client.js';
import { OperationsAuditRepository } from './operations-audit.repository.js';
import { OperationsAuditService } from './operations-audit.service.js';
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
 * Catalog's side of the one question a publish must never guess at: has
 * this dated trip already sold or held seats (TA-20). Minimal for now --
 * later tasks add the publish service, controller and entities here.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([TimetableEntity, OperationsAuditEntity]),
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
  ],
  exports: [
    InventorySeatUsageClient,
    TimetableVersionService,
    OperationsAuditService,
  ],
})
export class OperationsModule {}
