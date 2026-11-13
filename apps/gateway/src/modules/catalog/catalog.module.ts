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
            // Nest passes this straight to proto-loader's loadSync and merges
            // nothing, so these two are the whole decode configuration.
            // Measured against catalog.proto rather than assumed:
            //
            //   {}                      -> trips absent, reason 1
            //   { arrays: true }        -> trips [],     reason 1
            //   { enums: String, arrays: true } -> trips [], reason the name
            loader: {
              // The empty result's reason IS the message-catalogue key, so a
              // numeric `1` resolves to the generic error sentence instead of
              // "change the stations".
              enums: String,
              // An empty repeated field is otherwise absent, making a client
              // distinguish "no trains" from a missing key.
              arrays: true,
              // `defaults: true` is not set because it adds nothing here: it
              // also populates empty arrays, but `arrays` already does, and it
              // does NOT affect the optional train number -- proto3 explicit
              // presence is respected either way, which was measured.
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
