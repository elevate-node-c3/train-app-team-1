import { afterEach, describe, expect, it, vi } from 'vitest';
import { of } from 'rxjs';
import type { Metadata } from '@grpc/grpc-js';
import type { ClsService } from 'nestjs-cls';
import { FlowGrpcClientsService } from './flow-grpc-clients.service.js';
import type {
  CatalogFlowClient,
  PaymentFlowClient,
  InventoryFlowClient,
} from '../flow-clients.types.js';

afterEach(() => vi.unstubAllEnvs());

describe('FlowGrpcClientsService inventory metadata', () => {
  it('authenticates settlement and release with the booking credential', async () => {
    vi.stubEnv('BOOKING_INVENTORY_SERVICE_KEY', 'test-booking-key');
    const settleHold = vi.fn(() =>
      of({ outcome: 'NO_SEATS', assignments: [] }),
    );
    const releaseHold = vi.fn(() => of({ state: 'RELEASED' }));
    const service = new FlowGrpcClientsService(
      {} as CatalogFlowClient,
      {} as PaymentFlowClient,
      { settleHold, releaseHold } as unknown as InventoryFlowClient,
      { get: () => 'correlation-1' } as unknown as ClsService,
    );
    const request = { ownerId: 'owner', bookingKey: 'booking' };
    await service.settleHold(request);
    await service.releaseHold(request);
    for (const invoke of [settleHold, releaseHold]) {
      const [sent, metadata, options] = invoke.mock.calls[0] as unknown as [
        typeof request,
        Metadata,
        { deadline: number },
      ];
      expect(sent).toEqual(request);
      expect(metadata.get('x-booking-inventory-key')).toEqual([
        'test-booking-key',
      ]);
      expect(metadata.get('x-correlation-id')).toEqual(['correlation-1']);
      expect(options.deadline).toBeGreaterThan(Date.now());
    }
  });
});
