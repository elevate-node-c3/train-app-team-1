import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import {
  ClientGrpc,
  ClientProxyFactory,
  Transport,
} from '@nestjs/microservices';
import { ClsService } from 'nestjs-cls';
import { firstValueFrom, timeout } from 'rxjs';
import {
  AggregatedHealthReport,
  getHealthProtoPath,
  HEALTH_PACKAGE_NAME,
  HEALTH_SERVICE_NAME,
  HealthState,
  ServiceHealthReport,
} from '@app/contracts';
import {
  HealthService as CommonHealthService,
  createGrpcMetadataWithCorrelation,
} from '@app/common';
import {
  DOWNSTREAM_SERVICES,
  downstreamGrpcUrlsFromEnv,
} from '../../config/grpc-settings.js';

interface HealthGrpcClient {
  check(
    data: { service: string },
    metadata?: unknown,
  ): import('rxjs').Observable<{
    status: number;
    service: string;
    message: string;
    details: Record<string, string>;
  }>;
}

@Injectable()
export class HealthService implements OnModuleInit {
  private readonly logger = new Logger(HealthService.name);
  private grpcClients: Map<string, HealthGrpcClient> = new Map();

  constructor(
    private readonly localHealthService: CommonHealthService,
    private readonly cls: ClsService,
  ) {}

  onModuleInit(): void {
    const protoPath = getHealthProtoPath();
    const urls = downstreamGrpcUrlsFromEnv();

    for (const service of DOWNSTREAM_SERVICES) {
      const url = urls[service];

      try {
        const client: ClientGrpc = ClientProxyFactory.create({
          transport: Transport.GRPC,
          options: {
            package: HEALTH_PACKAGE_NAME,
            protoPath,
            url,
          },
        });
        const grpcService =
          client.getService<HealthGrpcClient>(HEALTH_SERVICE_NAME);
        this.grpcClients.set(service, grpcService);
      } catch (err: unknown) {
        this.logger.warn(
          `Failed to initialize gRPC client for ${service}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  async aggregate(): Promise<AggregatedHealthReport> {
    const gatewayReport =
      await this.localHealthService.checkReadiness('gateway');

    const downstreamReports: Record<string, ServiceHealthReport> = {};

    for (const service of DOWNSTREAM_SERVICES) {
      const client = this.grpcClients.get(service);
      if (!client) {
        downstreamReports[service] = {
          service,
          status: 'down',
          dependencies: {
            client: { status: 'not_ready', message: 'Client not initialized' },
          },
          timestamp: new Date().toISOString(),
        };
        continue;
      }

      try {
        const metadata = createGrpcMetadataWithCorrelation(this.cls);
        this.logger.log(`Dispatching gRPC health check to ${service}`);
        const response$ = client
          .check({ service }, metadata)
          .pipe(timeout(2500));
        const res = await firstValueFrom(response$);

        let status: HealthState = 'ready';
        if (res.status === 2) {
          status = 'not_ready';
        } else if (res.status === 4) {
          status = 'degraded';
        }

        const deps: Record<string, { status: HealthState }> = {};
        for (const [k, v] of Object.entries(res.details || {})) {
          deps[k] = { status: v as HealthState };
        }

        downstreamReports[service] = {
          service: res.service || service,
          status,
          dependencies: deps,
          timestamp: new Date().toISOString(),
        };
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `Downstream service ${service} is unavailable via gRPC: ${errMsg}`,
        );
        downstreamReports[service] = {
          service,
          status: 'down',
          dependencies: { grpc: { status: 'not_ready', message: errMsg } },
          timestamp: new Date().toISOString(),
        };
      }
    }

    const allReady =
      gatewayReport.status === 'ready' &&
      Object.values(downstreamReports).every((r) => r.status === 'ready');

    const anyDown =
      gatewayReport.status === 'not_ready' ||
      Object.values(downstreamReports).some(
        (r) => r.status === 'down' || r.status === 'not_ready',
      );

    let overallStatus: HealthState = 'ready';
    if (anyDown) {
      overallStatus = 'not_ready';
    } else if (!allReady) {
      overallStatus = 'degraded';
    }

    return {
      status: overallStatus,
      gateway: gatewayReport,
      services: downstreamReports,
      timestamp: new Date().toISOString(),
    };
  }
}
