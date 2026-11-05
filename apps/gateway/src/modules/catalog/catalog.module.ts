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
            loader: {
              // Without this an enum decodes to its number, and the empty
              // result's reason IS the message-catalogue key -- so a reason of
              // `1` silently resolves to the generic error sentence instead of
              // "change the stations". The contract declares string names.
              enums: String,
              // A repeated field defaults to absent when empty, which makes a
              // client distinguish "no trains" from a missing key. Always an
              // array, so it cannot.
              arrays: true,
              // `defaults` is deliberately NOT set: it would populate every
              // scalar with its zero value and destroy the distinction between
              // an absent optional train number and train number 0.
            },
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
