import { describe, expect, it, vi } from 'vitest';
import {
  AllocationOutcome,
  ErrorCode,
  type SettlementSnapshot,
} from '@app/contracts';
import { HoldCoreError } from '../hold-core.errors.js';
import { HoldSettlementService } from './hold-settlement.service.js';

const request = { ownerId: 'owner', bookingKey: 'booking' };
const now = new Date('2026-11-22T12:00:00Z');
const assignments: SettlementSnapshot['assignments'] = [
  {
    passengerRef: 'p1',
    passengerKeyVersion: 1,
    tripId: 'trip',
    tripSeatId: 'seat',
    travelClassId: 'class',
    coachNumber: 1,
    seatNumber: '1A',
    rowNumber: 1,
    label: 'A',
    outcome: AllocationOutcome.SAME_COACH,
    originStationId: 'origin',
    destinationStationId: 'destination',
    originPosition: 0,
    destinationPosition: 2,
  },
];

function fixture() {
  const hold = {
    id: 'hold',
    ownerId: 'owner',
    state: 'held',
    settlementOutcome: null as SettlementSnapshot['outcome'] | null,
  };
  const repository = {
    lockHoldByKey: vi.fn().mockImplementation(async () => hold),
    legTripIds: vi.fn().mockResolvedValue(['trip']),
    lockTrips: vi.fn().mockResolvedValue(undefined),
    sampleNow: vi.fn().mockResolvedValue(now),
    reclaimExpiredOccupations: vi.fn().mockResolvedValue(undefined),
    loadLegInputs: vi.fn().mockResolvedValue([]),
    resolveLegFacts: vi.fn().mockResolvedValue([]),
    hasCompleteSettlementReceipt: vi.fn().mockResolvedValue(true),
    hasLiveOccupations: vi.fn().mockResolvedValue(true),
    hasCompleteLiveOccupations: vi.fn().mockResolvedValue(true),
    passengersClearForSettlement: vi.fn().mockResolvedValue(true),
    attemptSettlement: vi.fn().mockImplementation(async (ctx, work) => work()),
    sellHold: vi.fn().mockImplementation(async () => {
      hold.state = 'sold';
      hold.settlementOutcome = 'SOLD';
    }),
    reacquireSameSeats: vi.fn().mockResolvedValue(false),
    reallocateForBooking: vi.fn().mockImplementation(async () => {
      hold.state = 'sold';
      hold.settlementOutcome = 'REALLOCATED';
      return true;
    }),
    recordNoSeats: vi.fn().mockImplementation(async () => {
      hold.settlementOutcome = 'NO_SEATS';
      hold.state = 'released';
    }),
    loadSettlement: vi.fn().mockResolvedValue({ legs: [], assignments }),
  };
  const availability = { publishChange: vi.fn().mockResolvedValue(undefined) };
  const ctx = {};
  const service = new HoldSettlementService(
    repository as never,
    { withTransaction: async (work) => work(ctx as never) },
    availability as never,
  );
  return { service, repository, availability, hold, ctx };
}

describe('HoldSettlementService', () => {
  it('sells a complete live hold and preserves allocation metadata', async () => {
    const { service, repository } = fixture();
    const result = await service.settle(request);
    expect(result).toMatchObject({
      outcome: 'SOLD',
      assignments,
      serverNow: now.toISOString(),
    });
    expect(repository.sellHold).toHaveBeenCalledOnce();
    expect(repository.reallocateForBooking).not.toHaveBeenCalled();
  });

  it('replays the original reallocation after a lost response', async () => {
    const { service, repository, availability } = fixture();
    repository.hasLiveOccupations.mockResolvedValue(false);
    const first = await service.settle(request);
    const replay = await service.settle(request);
    expect(first.outcome).toBe('REALLOCATED');
    expect(replay).toEqual(first);
    expect(repository.reallocateForBooking).toHaveBeenCalledOnce();
    expect(availability.publishChange).toHaveBeenCalledOnce();
  });

  it('never sells on a retry after a durable NO_SEATS decision', async () => {
    const { service, repository, availability } = fixture();
    repository.hasLiveOccupations.mockResolvedValue(false);
    repository.reallocateForBooking.mockResolvedValue(false);
    expect((await service.settle(request)).outcome).toBe('NO_SEATS');
    repository.reacquireSameSeats.mockResolvedValue(true);
    expect((await service.settle(request)).outcome).toBe('NO_SEATS');
    expect(repository.recordNoSeats).toHaveBeenCalledOnce();
    expect(repository.reacquireSameSeats).toHaveBeenCalledOnce();
    expect(availability.publishChange).toHaveBeenCalledOnce();
  });

  it('refuses a passenger overlap before acquiring any leg', async () => {
    const { service, repository } = fixture();
    repository.hasLiveOccupations.mockResolvedValue(false);
    repository.passengersClearForSettlement.mockResolvedValue(false);
    expect((await service.settle(request)).outcome).toBe('NO_SEATS');
    expect(repository.reacquireSameSeats).not.toHaveBeenCalled();
    expect(repository.reallocateForBooking).not.toHaveBeenCalled();
    expect(repository.recordNoSeats).toHaveBeenCalledOnce();
  });

  it('persists the refusal after a passenger-constraint rollback', async () => {
    const { service, repository } = fixture();
    repository.attemptSettlement.mockResolvedValue('NO_SEATS');
    expect((await service.settle(request)).outcome).toBe('NO_SEATS');
    expect(repository.recordNoSeats).toHaveBeenCalledOnce();
  });

  it('does not sell a cancellation tombstone', async () => {
    const { service, repository, hold } = fixture();
    hold.state = 'cancelled';
    expect((await service.settle(request)).outcome).toBe('NO_SEATS');
    expect(repository.attemptSettlement).not.toHaveBeenCalled();
    expect(repository.recordNoSeats).toHaveBeenCalledOnce();
  });

  it('refuses incomplete allocation receipts', async () => {
    const { service, repository } = fixture();
    repository.hasCompleteSettlementReceipt.mockResolvedValue(false);
    expect((await service.settle(request)).outcome).toBe('NO_SEATS');
    expect(repository.sellHold).not.toHaveBeenCalled();
    expect(repository.reacquireSameSeats).not.toHaveBeenCalled();
  });

  it('never sells only the surviving live occupations', async () => {
    const { service, repository } = fixture();
    repository.hasCompleteLiveOccupations.mockResolvedValue(false);
    expect((await service.settle(request)).outcome).toBe('NO_SEATS');
    expect(repository.sellHold).not.toHaveBeenCalled();
    expect(repository.recordNoSeats).toHaveBeenCalledOnce();
  });

  it('releases a complete live hold when its trip is closed', async () => {
    const { service, repository } = fixture();
    repository.resolveLegFacts.mockRejectedValue(
      new HoldCoreError(ErrorCode.SALES_CLOSED),
    );
    expect((await service.settle(request)).outcome).toBe('NO_SEATS');
    expect(repository.recordNoSeats).toHaveBeenCalledOnce();
    expect(repository.sellHold).not.toHaveBeenCalled();
  });

  it('samples time only after the hold and all trip lock waits finish', async () => {
    const { service, repository, hold } = fixture();
    const calls: string[] = [];
    let unlock!: () => void;
    const wait = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    repository.lockHoldByKey.mockImplementation(async () => {
      calls.push('hold');
      return hold;
    });
    repository.lockTrips.mockImplementation(async () => {
      calls.push('trips');
      await wait;
    });
    repository.sampleNow.mockImplementation(async () => {
      calls.push('time');
      return now;
    });
    const result = service.settle(request);
    await vi.waitFor(() => expect(calls).toEqual(['hold', 'trips']));
    expect(repository.sampleNow).not.toHaveBeenCalled();
    unlock();
    await result;
    expect(calls).toEqual(['hold', 'trips', 'time']);
  });

  it('does not turn infrastructure failures into terminal refusals', async () => {
    const { service, repository } = fixture();
    repository.resolveLegFacts.mockRejectedValue(new Error('connection lost'));
    await expect(service.settle(request)).rejects.toThrow('connection lost');
    expect(repository.recordNoSeats).not.toHaveBeenCalled();
  });

  it('rejects a different owner before any trip lock or settlement write', async () => {
    const { service, repository } = fixture();
    await expect(
      service.settle({ ...request, ownerId: 'another' }),
    ).rejects.toMatchObject({ code: ErrorCode.HOLD_NOT_FOUND });
    expect(repository.lockTrips).not.toHaveBeenCalled();
    expect(repository.recordNoSeats).not.toHaveBeenCalled();
  });
});
