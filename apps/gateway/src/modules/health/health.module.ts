import { Global, Module } from '@nestjs/common';
import {
  ClientsModule,
  Transport,
  type ClientGrpc,
} from '@nestjs/microservices';
import { AGGREGATE_READINESS, CommonModule } from '@app/common';
import {
  getHealthProtoPath,
  HEALTH_PACKAGE_NAME,
  HEALTH_SERVICE_NAME,
} from '@app/contracts';
import {
  DOWNSTREAM_SERVICES,
  downstreamGrpcUrlsFromEnv,
  type DownstreamService,
} from '../../config/grpc-settings.js';
import { HealthController } from './health.controller.js';
import { HealthService } from './health.service.js';
import { HEALTH_GRPC_CLIENTS, type HealthGrpcClient } from './health.types.js';

export { HEALTH_GRPC_CLIENTS };

const healthClientToken = (service: DownstreamService) =>
  `HEALTH_GRPC_${service.toUpperCase()}`;

/**
 * `@Global()` so `@app/common`'s HealthController can resolve
 * `AGGREGATE_READINESS` without the library importing this app — which it
 * cannot. Binding it here is what replaced `if (process.env.APP ===
 * 'gateway')` inside that shared controller.
 *
 * One token for both routes: `/health` reaches it through the library's
 * controller, `/api/ping-all` through this module's own.
 */
@Global()
@Module({
  imports: [
    CommonModule,
    ClientsModule.registerAsync(
      DOWNSTREAM_SERVICES.map((service) => ({
        name: healthClientToken(service),
        useFactory: () => ({
          transport: Transport.GRPC,
          options: {
            package: HEALTH_PACKAGE_NAME,
            protoPath: getHealthProtoPath(),
            url: downstreamGrpcUrlsFromEnv()[service],
          },
        }),
      })),
    ),
  ],
  controllers: [HealthController],
  providers: [
    HealthService,
    {
      provide: HEALTH_GRPC_CLIENTS,
      inject: DOWNSTREAM_SERVICES.map(healthClientToken),
      useFactory: (...clients: ClientGrpc[]) =>
        new Map<string, HealthGrpcClient>(
          DOWNSTREAM_SERVICES.map(
            (service, index) =>
              [
                service,
                clients[index].getService<HealthGrpcClient>(
                  HEALTH_SERVICE_NAME,
                ),
              ] as const,
          ),
        ),
    },
    { provide: AGGREGATE_READINESS, useExisting: HealthService },
  ],
  exports: [AGGREGATE_READINESS],
})
export class HealthModule {}
