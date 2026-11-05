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
import {
  CATALOG_GRPC_CLIENT,
  type CatalogGrpcClient,
} from './catalog.types.js';

const CATALOG_CLIENT = 'CATALOG_GRPC';

/**
 * The gateway's side of catalog search.
 *
 * Declarative `ClientsModule` rather than a hand-rolled `@grpc/grpc-js`
 * client: it is the newer of the two conventions here -- commit 1a051d1
 * migrated health onto it -- and it means no `onModuleInit`/`onModuleDestroy`
 * lifecycle to re-implement.
 *
 * The proxy is resolved once into an injectable token, so the client service
 * takes a ready interface rather than a `ClientGrpc` it has to unwrap.
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
          },
        }),
      },
    ]),
  ],
  controllers: [CatalogController],
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
