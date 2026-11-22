import { afterEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import type { ClsService } from 'nestjs-cls';
import type { OutboxPort } from '@app/messaging';
import type { UnitOfWorkPort } from '@app/common/persistence/unit-of-work.port.js';
import { BookingDraftEntity } from '../../draft/entities/booking-draft.entity.js';
import type { BookingDraftService } from '../../draft/booking-draft.service.js';
import type { BookingFlowRepository } from '../booking-flow.repository.js';
import type { FlowGrpcClientsService } from './flow-grpc-clients.service.js';
import { BookingFlowService } from './booking-flow.service.js';

afterEach(() => vi.restoreAllMocks());

function fixture() {
  vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  const draft: BookingDraftEntity = Object.assign(new BookingDraftEntity(), {
    id: 'booking',
    userId: 'owner',
    holdId: 'hold',
    holdReleased: false,
    flowState: 'abandoned',
    paymentSucceededAt: null,
    compensationStatus: 'pending',
    compensationAttempts: 0,
    paymentAttempted: true,
    paymentReference: 'payment',
  });
  const repository = {
    findById: vi.fn().mockResolvedValue(draft),
    markHoldReleased: vi.fn(),
    recordCompensationFailure: vi.fn(),
    completeCompensation: vi.fn(),
    markChargeCancelled: vi.fn(),
  };
  const drafts = { releaseHold: vi.fn() };
  const clients = {
    cancelCharge: vi.fn().mockResolvedValue({ status: 'CANCELLED' }),
  };
  const service = new BookingFlowService(
    repository as unknown as BookingFlowRepository,
    drafts as unknown as BookingDraftService,
    clients as unknown as FlowGrpcClientsService,
    {} as ClsService,
    {} as UnitOfWorkPort,
    {} as OutboxPort,
  );
  return { draft, repository, drafts, clients, service };
}

describe('BookingFlowService compensation fencing', () => {
  it('does not record an ambiguous hold release as completed or cancel payment before cleanup', async () => {
    const { repository, drafts, clients, service } = fixture();
    drafts.releaseHold.mockResolvedValue({
      holdState: 'HELD',
      reconciliationPending: true,
    });
    await service.compensate('booking');
    expect(repository.markHoldReleased).not.toHaveBeenCalled();
    expect(clients.cancelCharge).not.toHaveBeenCalled();
    expect(repository.completeCompensation).not.toHaveBeenCalled();
    expect(repository.recordCompensationFailure).toHaveBeenCalledWith(
      'booking',
      2_000,
      'Hold release has not been acknowledged',
    );
  });

  it('stands down after verified payment wins while release is in flight', async () => {
    const { draft, repository, drafts, clients, service } = fixture();
    drafts.releaseHold.mockImplementation(async () => {
      draft.flowState = 'refunding';
      draft.paymentSucceededAt = new Date();
      draft.compensationStatus = 'none';
      return { holdState: 'RELEASED', reconciliationPending: false };
    });
    await service.compensate('booking');
    expect(clients.cancelCharge).not.toHaveBeenCalled();
    expect(repository.completeCompensation).not.toHaveBeenCalled();
    expect(repository.recordCompensationFailure).not.toHaveBeenCalled();
  });
});
