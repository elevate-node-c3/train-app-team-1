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
import { OperationsController } from './operations.controller.js';
import { OperationsGrpcClientService } from './operations.grpc.client.js';
import { OperationsService } from './operations.service.js';
import {
  OPERATIONS_GRPC_CLIENT,
  type OperationsGrpcClient,
} from './operations.types.js';

const OPERATIONS_CLIENT = 'OPERATIONS_GRPC';

/**
 * A second catalog client on purpose; sharing `CatalogModule`'s proxy would
 * couple the two surfaces. The loader options must match catalog's.
 */
@Module({
  imports: [
    ClientsModule.registerAsync([
      {
        name: OPERATIONS_CLIENT,
        useFactory: () => ({
          transport: Transport.GRPC,
          options: {
            package: CATALOG_PACKAGE_NAME,
            protoPath: getCatalogProtoPath(),
            url: downstreamGrpcUrlsFromEnv().catalog,
            loader: {
              enums: String,
              arrays: true,
            },
          },
        }),
      },
    ]),
  ],
  controllers: [OperationsController],
  providers: [
    {
      provide: OPERATIONS_GRPC_CLIENT,
      inject: [OPERATIONS_CLIENT],
      useFactory: (client: ClientGrpc) =>
        client.getService<OperationsGrpcClient>(CATALOG_SERVICE_NAME),
    },
    OperationsGrpcClientService,
    OperationsService,
  ],
})
export class OperationsModule {}
