import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { getInventoryProtoPath, INVENTORY_PACKAGE_NAME } from '@app/contracts';

import {
  INVENTORY_GRPC_CLIENT,
  InventorySeatUsageClient,
} from './inventory-seat-usage.grpc.client.js';

const DEFAULT_INVENTORY_GRPC_URL = 'inventory:50051';

/**
 * Catalog's side of the one question a publish must never guess at: has
 * this dated trip already sold or held seats (TA-20). Minimal for now --
 * later tasks add the publish service, controller and entities here.
 */
@Module({
  imports: [
    ClientsModule.registerAsync([
      {
        name: INVENTORY_GRPC_CLIENT,
        useFactory: () => ({
          transport: Transport.GRPC,
          options: {
            package: INVENTORY_PACKAGE_NAME,
            protoPath: getInventoryProtoPath(),
            url: process.env.INVENTORY_GRPC_URL ?? DEFAULT_INVENTORY_GRPC_URL,
            // Must match inventory's own server loader options or a
            // `repeated` field arrives in an unexpected shape.
            loader: { enums: String, arrays: true },
          },
        }),
      },
    ]),
  ],
  providers: [InventorySeatUsageClient],
  exports: [InventorySeatUsageClient],
})
export class OperationsModule {}
