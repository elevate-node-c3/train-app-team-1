import { describe, expect, it, vi } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import { ClsService } from 'nestjs-cls';
import { of, throwError } from 'rxjs';
import { HealthService as CommonHealthService } from '@app/common';
import type { ServiceHealthReport } from '@app/contracts';
import { DOWNSTREAM_SERVICES } from '../../config/grpc-settings.js';
import { HEALTH_GRPC_CLIENTS } from './health.module.js';
import { HealthService } from './health.service.js';
import type { HealthGrpcClient, HealthGrpcResponse } from './health.types.js';

const GATEWAY_READY: ServiceHealthReport = {
  service: 'gateway',
  status: 'ready',
  dependencies: {},
  timestamp: '2026-10-27T00:00:00.000Z',
};

type StubHealthClient = HealthGrpcClient & {
  check: ReturnType<typeof vi.fn>;
};

function readyClient(service: string): StubHealthClient {
  return {
    check: vi.fn(() =>
      of<HealthGrpcResponse>({
        status: 0,
        service,
        message: '',
        details: { database: 'ready' },
      }),
    ),
  } as StubHealthClient;
}

function failingClient(message: string): StubHealthClient {
  return {
    check: vi.fn(() => throwError(() => new Error(message))),
  } as StubHealthClient;
}

function readyClients(): Map<string, HealthGrpcClient> {
  const clients = new Map<string, HealthGrpcClient>();
  for (const service of DOWNSTREAM_SERVICES) {
    clients.set(service, readyClient(service));
  }
  return clients;
}

async function harness(clients: Map<string, HealthGrpcClient>): Promise<{
  moduleRef: TestingModule;
  service: HealthService;
}> {
  const moduleRef = await Test.createTestingModule({
    providers: [
      HealthService,
      {
        provide: CommonHealthService,
        useValue: {
          checkReadiness: vi.fn(async () => GATEWAY_READY),
        },
      },
      { provide: ClsService, useValue: { get: () => undefined } },
      // Present so the override below exercises the same token the module uses.
      { provide: HEALTH_GRPC_CLIENTS, useValue: new Map() },
    ],
  })
    .overrideProvider(HEALTH_GRPC_CLIENTS)
    .useValue(clients)
    .compile();

  return { moduleRef, service: moduleRef.get(HealthService) };
}

describe('HealthService aggregation', () => {
  it('reports all six ready clients and sends a gRPC deadline', async () => {
    const clients = readyClients();
    const { moduleRef, service } = await harness(clients);

    try {
      const report = await service.aggregate();

      expect(report.status).toBe('ready');
      expect(Object.keys(report.services)).toEqual([...DOWNSTREAM_SERVICES]);
      for (const serviceName of DOWNSTREAM_SERVICES) {
        expect(report.services[serviceName]).toMatchObject({
          service: serviceName,
          status: 'ready',
        });
        expect(
          (clients.get(serviceName) as StubHealthClient).check,
        ).toHaveBeenCalledWith(
          { service: serviceName },
          expect.anything(),
          expect.objectContaining({ deadline: expect.any(Number) }),
        );
      }
    } finally {
      await moduleRef.close();
    }
  });

  it('maps a failing client to down without aborting the aggregate', async () => {
    const clients = readyClients();
    clients.set('payment', failingClient('payment unavailable'));
    const { moduleRef, service } = await harness(clients);

    try {
      const report = await service.aggregate();

      expect(report.status).toBe('not_ready');
      expect(report.services.payment).toMatchObject({
        service: 'payment',
        status: 'down',
        dependencies: {
          grpc: { status: 'not_ready', message: 'payment unavailable' },
        },
      });
      expect(report.services.catalog.status).toBe('ready');
    } finally {
      await moduleRef.close();
    }
  });
});
