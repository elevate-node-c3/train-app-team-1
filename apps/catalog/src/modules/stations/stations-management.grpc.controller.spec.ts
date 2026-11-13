import { describe, expect, it, vi } from 'vitest';
import { Metadata } from '@grpc/grpc-js';
import { RpcException } from '@nestjs/microservices';
import type { ClsService } from 'nestjs-cls';
import type { StationsManagementService } from './stations-management.service.js';
import { StationsManagementGrpcController } from './stations-management.grpc.controller.js';

const request = { cityId: 'city-id', nameAr: 'محطة', nameEn: 'Station' };
function controller(actor?: string) {
  const management = {
    get: vi.fn(async () => ({ station: { id: 'id' } })),
    create: vi.fn(async () => ({ station: { id: 'id' } })),
    update: vi.fn(async () => ({ station: { id: 'id' } })),
    deactivate: vi.fn(async () => ({ station: { id: 'id', isActive: false } })),
  };
  const cls = { get: () => actor };
  return { management, instance: new StationsManagementGrpcController(management as unknown as StationsManagementService, cls as unknown as ClsService) };
}

describe('station-management RPC context', () => {
  it('requires forwarded attribution and idempotency before changing a station', async () => {
    const h = controller();
    const error = await h.instance.createStation(request).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RpcException);
    const payload = (error as RpcException).getError() as { details: string };
    expect(JSON.parse(payload.details).details.map((detail: { field: string }) => detail.field)).toEqual(['callerAccountId', 'Idempotency-Key']);
    expect(h.management.create).not.toHaveBeenCalled();
  });

  it('forwards one trimmed key and the trusted caller to every mutation', async () => {
    const h = controller('operator-id');
    const metadata = new Metadata(); metadata.set('idempotency-key', ' key ');
    await h.instance.createStation(request, metadata);
    await h.instance.updateStation({ stationId: 'id', isActive: false }, metadata);
    await h.instance.deactivateStation({ stationId: 'id' }, metadata);
    expect(h.management.create).toHaveBeenCalledWith(request, 'key', 'operator-id');
    expect(h.management.update).toHaveBeenCalledWith({ stationId: 'id', isActive: false }, 'key', 'operator-id');
    expect(h.management.deactivate).toHaveBeenCalledWith('id', 'key', 'operator-id');
  });

  it('reads the full station snapshot without performing a mutation', async () => {
    const h = controller();
    await h.instance.getStation({ stationId: 'id' });
    expect(h.management.get).toHaveBeenCalledWith('id');
    expect(h.management.create).not.toHaveBeenCalled();
  });
});
