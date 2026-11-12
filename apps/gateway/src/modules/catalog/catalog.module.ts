import { Module } from '@nestjs/common';
import {
  ClientsModule,
  Transport,
  type ClientGrpc,
} from '@nestjs/microservices';
import {
  CATALOG_PACKAGE_NAME,
  CATALOG_SERVICE_NAME,
  getCatalogProtoPath,
} from '@app/contracts';

import { downstreamGrpcUrlsFromEnv } from '../../config/grpc-settings.js';
import { CatalogController } from './catalog.controller.js';
import { CatalogGrpcClientService } from './catalog.grpc.client.js';
import { CatalogService } from './catalog.service.js';
import { StationsController } from './stations.controller.js';
import {
  CATALOG_GRPC_CLIENT,
  type CatalogGrpcClient,
} from './catalog.types.js';

const CATALOG_CLIENT = 'CATALOG_GRPC';

/**
 * ClientsModule owns the connection lifecycle.
 * Resolve its proxy once so services receive a ready client.
 */
@Module({
  imports: [
    ClientsModule.registerAsync([
      {
        name: CATALOG_CLIENT,
        useFactory: () => ({
          transport: Transport.GRPC,
          options: {
            package: CATALOG_PACKAGE_NAME,
            protoPath: getCatalogProtoPath(),
            url: downstreamGrpcUrlsFromEnv().catalog,
            loader: {
              // Enum names are message keys, not numeric codes.
              enums: String,
              // Return empty arrays instead of missing repeated fields.
              arrays: true,
            },
          },
        }),
      },
    ]),
  ],
  controllers: [CatalogController, StationsController],
  providers: [
    {
      provide: CATALOG_GRPC_CLIENT,
      inject: [CATALOG_CLIENT],
      useFactory: (client: ClientGrpc) =>
        client.getService<CatalogGrpcClient>(CATALOG_SERVICE_NAME),
    },
    CatalogGrpcClientService,
    CatalogService,
  ],
})
export class CatalogModule {}
