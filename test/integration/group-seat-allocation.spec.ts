import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HttpException, HttpStatus } from '@nestjs/common';
import {
  AllocationOutcome,
  ErrorCode,
  SEATS_SPLIT_NOTICE,
  type HoldSeatsResponse,
} from '@app/contracts';
import { BookingController } from '../../apps/gateway/src/modules/booking/booking.controller.js';
import { BookingService } from '../../apps/gateway/src/modules/booking/booking.service.js';
import {
  BookingDraftService,
  type InventoryGrpcService,
} from '../../apps/booking/src/modules/draft/booking-draft.service.js';
import { allocateGroupSeats } from '../../apps/inventory/src/modules/seat-allocation/seat-allocator.js';
import type { AllocatableSeat } from '../../apps/inventory/src/modules/seat-allocation/seat-allocator.types.js';

/**
 * Builds the trip_seat rows of a standard 2+2 coach with `rowCount` rows.
 * Numbering:
 * row 1: left: ['1', '2'], right: ['3', '4']
 * row 2: left: ['5', '6'], right: ['7', '8'], etc.
 * seatId is `${coachNumber}:${seatNumber}` so a test can name seats directly.
 */
function createStandardCoach(
  coachNumber: number,
  rowCount = 5,
  seatsPerRowLeft = 2,
  seatsPerRowRight = 2,
): AllocatableSeat[] {
  const seats: AllocatableSeat[] = [];
  let seatCounter = 1;
  for (let rowNumber = 1; rowNumber <= rowCount; rowNumber++) {
    for (const [side, perRow] of [
      ['left', seatsPerRowLeft],
      ['right', seatsPerRowRight],
    ] as const) {
      for (let seatIndexInSide = 0; seatIndexInSide < perRow; seatIndexInSide++) {
        const seatNumber = String(seatCounter++);
        seats.push({
          seatId: `${coachNumber}:${seatNumber}`,
          coachNumber,
          rowNumber,
          side,
          seatIndexInSide,
          seatNumber,
        });
      }
    }
  }
  return seats;
}

/** Everything the free list does not name is occupied over the wanted segment. */
function occupiedExcept(
  seats: AllocatableSeat[],
  freeSeatIds: string[],
): string[] {
  const free = new Set(freeSeatIds);
  return seats.filter((s) => !free.has(s.seatId)).map((s) => s.seatId);
}

describe('Group Seat Allocation End-to-End Integration Flow', () => {
  let controller: BookingController;
  let gatewayBookingService: BookingService;
  let backendDraftService: BookingDraftService;
  let mockDraftRepository: any;
  let mockInventoryService: InventoryGrpcService;
  let mockClsService: any;

  // Stored drafts for in-memory persistence verification
  const draftDb = new Map<string, any>();

  beforeEach(() => {
    draftDb.clear();

    mockDraftRepository = {
      create: vi.fn((entity: any) => ({
        id:
          entity.id ??
          `draft-${Date.now()}-${Math.random().toString(36).substring(7)}`,
        ...entity,
        createdAt: new Date().toISOString(),
      })),
      save: vi.fn(async (entity: any) => {
        draftDb.set(entity.id, entity);
        return entity;
      }),
      findOne: vi.fn(async ({ where }: any) => {
        return draftDb.get(where?.id) ?? null;
      }),
    };

    mockInventoryService = {
      holdSeats: vi.fn(),
      releaseSeats: vi.fn().mockResolvedValue({ success: true }),
    };

    backendDraftService = new BookingDraftService(
      mockDraftRepository,
      mockInventoryService,
    );

    // Wire Gateway BookingService to call backend BookingDraftService
    const mockBookingClient = {
      createDraft: vi.fn(async (dto: any, userId: string) => {
        return backendDraftService.createDraft({ ...dto, userId });
      }),
    };

    gatewayBookingService = new BookingService(mockBookingClient as any);

    mockClsService = {
      get: vi.fn().mockReturnValue('traveller-account-uuid-99'),
    };

    controller = new BookingController(gatewayBookingService, mockClsService);
  });

  it('Flow 1: Group of 2 gets side-by-side seats (Tier 1)', async () => {
    // Inventory setup: Coach 1 has free adjacent seats (1, 2)
    const seats = createStandardCoach(1, 5);
    const allocResult = allocateGroupSeats({
      seats,
      occupiedSeatIds: occupiedExcept(seats, ['1:1', '1:2', '1:3', '1:4']),
      groupSize: 2,
    });

    expect(allocResult.success).toBe(true);
    if (!allocResult.success) throw new Error('Allocation failed');
    expect(allocResult.outcome).toBe(AllocationOutcome.SIDE_BY_SIDE);

    vi.mocked(mockInventoryService.holdSeats).mockResolvedValueOnce({
      holdId: 'hold-t1-group2',
      allocationOutcome: allocResult.outcome,
      seats: allocResult.seats,
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    });

    const clientPayload = {
      tripId: '11111111-1111-4111-8111-111111111111',
      travelClassId: 'class-ac1',
      originStationId: '22222222-2222-4222-8222-222222222222',
      destinationStationId: '33333333-3333-4333-8333-333333333333',
      groupSize: 2,
    };

    const response = await controller.createBooking(
      clientPayload as any,
      { body: clientPayload } as any,
    );

    expect(response.status).toBe('PENDING');
    expect(response.legs).toHaveLength(1);
    const leg = response.legs[0];
    expect(leg.allocationOutcome).toBe(AllocationOutcome.SIDE_BY_SIDE);
    expect(leg.seats).toEqual([
      'Passenger · Coach 1 · Seat 1',
      'Passenger · Coach 1 · Seat 2',
    ]);
    expect(leg.splitNotice).toBeUndefined();
  });

  it('Flow 2: Group of 3 falls back to same-coach (Tier 2)', async () => {
    // Coach 1 has no 3 contiguous/clustered side-by-side seats, but has 3 seats in coach
    const seats = createStandardCoach(1, 5);
    // Isolated seats in Coach 1: row 1 left, row 1 right, row 2 left
    const allocResult = allocateGroupSeats({
      seats,
      occupiedSeatIds: occupiedExcept(seats, ['1:1', '1:4', '1:5']),
      groupSize: 3,
    });

    expect(allocResult.success).toBe(true);
    if (!allocResult.success) throw new Error('Allocation failed');
    expect(allocResult.outcome).toBe(AllocationOutcome.SAME_COACH);
    expect(allocResult.seats.every((s) => s.coachNumber === 1)).toBe(true);

    vi.mocked(mockInventoryService.holdSeats).mockResolvedValueOnce({
      holdId: 'hold-t2-group3',
      allocationOutcome: allocResult.outcome,
      seats: allocResult.seats,
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    });

    const clientPayload = {
      tripId: '11111111-1111-4111-8111-111111111111',
      travelClassId: 'class-ac1',
      originStationId: '22222222-2222-4222-8222-222222222222',
      destinationStationId: '33333333-3333-4333-8333-333333333333',
      groupSize: 3,
    };

    const response = await controller.createBooking(
      clientPayload as any,
      { body: clientPayload } as any,
    );

    expect(response.legs[0].allocationOutcome).toBe(AllocationOutcome.SAME_COACH);
    expect(response.legs[0].splitNotice).toBeUndefined();
    expect(response.legs[0].seats).toHaveLength(3);
    for (const seatLabel of response.legs[0].seats) {
      expect(seatLabel).toContain('Coach 1');
    }
  });

  it('Flow 3: Group of 4 split across minimal coaches carries SEATS_SPLIT_NOTICE (Tier 3)', async () => {
    // Coach 1 has 2 seats; Coach 2 has 2 seats; neither can accommodate all 4
    const seats = [...createStandardCoach(1, 5), ...createStandardCoach(2, 5)];
    const allocResult = allocateGroupSeats({
      seats,
      occupiedSeatIds: occupiedExcept(seats, ['1:1', '1:2', '2:1', '2:2']),
      groupSize: 4,
    });

    expect(allocResult.success).toBe(true);
    if (!allocResult.success) throw new Error('Allocation failed');
    expect(allocResult.outcome).toBe(AllocationOutcome.SPLIT);

    vi.mocked(mockInventoryService.holdSeats).mockResolvedValueOnce({
      holdId: 'hold-t3-group4',
      allocationOutcome: allocResult.outcome,
      seats: allocResult.seats,
      splitNotice: SEATS_SPLIT_NOTICE,
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    });

    const clientPayload = {
      tripId: '11111111-1111-4111-8111-111111111111',
      travelClassId: 'class-ac1',
      originStationId: '22222222-2222-4222-8222-222222222222',
      destinationStationId: '33333333-3333-4333-8333-333333333333',
      groupSize: 4,
    };

    const response = await controller.createBooking(
      clientPayload as any,
      { body: clientPayload } as any,
    );

    const leg = response.legs[0];
    expect(leg.allocationOutcome).toBe(AllocationOutcome.SPLIT);
    expect(leg.splitNotice).toBeDefined();
    expect(leg.splitNotice?.code).toBe('SEATS_SPLIT_NOTICE');
    // Verify Arabic copy
    expect(leg.splitNotice?.message).toBe(
      'تم توزيع المقاعد عبر أكثر من عربة لعدم توفر مقاعد متجاورة كافية',
    );
    // Verify English copy
    expect(leg.splitNotice?.messageEn).toBe(
      'Seats have been split across coaches because consecutive seats were unavailable',
    );
  });

  it('Flow 4: Attempting to name a seat/coach is rejected (BR-25, D2)', async () => {
    const forbiddenPayload = {
      tripId: '11111111-1111-4111-8111-111111111111',
      travelClassId: 'class-ac1',
      originStationId: '22222222-2222-4222-8222-222222222222',
      destinationStationId: '33333333-3333-4333-8333-333333333333',
      seatId: 'seat-manual-attempt',
      coachNumber: 3,
      groupSize: 2,
    };

    await expect(
      controller.createBooking(
        forbiddenPayload as any,
        { body: forbiddenPayload } as any,
      ),
    ).rejects.toThrowError(HttpException);

    try {
      await controller.createBooking(
        forbiddenPayload as any,
        { body: forbiddenPayload } as any,
      );
    } catch (error) {
      const httpError = error as HttpException;
      expect(httpError.getStatus()).toBe(HttpStatus.BAD_REQUEST);
      const res = httpError.getResponse() as Record<string, unknown>;
      expect(res.code).toBe(ErrorCode.INVALID_PAYLOAD);
    }

    // Server allocates rule: Inventory hold is never called
    expect(mockInventoryService.holdSeats).not.toHaveBeenCalled();
    expect(mockDraftRepository.save).not.toHaveBeenCalled();
  });

  it('Flow 5: Round trip with independent leg outcomes (outbound side-by-side, return split)', async () => {
    // Leg 1 Outbound: side-by-side
    const outboundHold: HoldSeatsResponse = {
      holdId: 'hold-outbound-roundtrip',
      allocationOutcome: AllocationOutcome.SIDE_BY_SIDE,
      seats: [
        {
          seatId: 'c1-s1',
          coachNumber: 1,
          seatNumber: '1',
          rowNumber: 1,
          label: 'Coach 1 · Seat 1',
        },
        {
          seatId: 'c1-s2',
          coachNumber: 1,
          seatNumber: '2',
          rowNumber: 1,
          label: 'Coach 1 · Seat 2',
        },
      ],
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    };

    // Leg 2 Return: split
    const returnHold: HoldSeatsResponse = {
      holdId: 'hold-return-roundtrip',
      allocationOutcome: AllocationOutcome.SPLIT,
      seats: [
        {
          seatId: 'c1-s1',
          coachNumber: 1,
          seatNumber: '1',
          rowNumber: 1,
          label: 'Coach 1 · Seat 1',
        },
        {
          seatId: 'c2-s1',
          coachNumber: 2,
          seatNumber: '1',
          rowNumber: 1,
          label: 'Coach 2 · Seat 1',
        },
      ],
      splitNotice: SEATS_SPLIT_NOTICE,
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    };

    vi.mocked(mockInventoryService.holdSeats)
      .mockResolvedValueOnce(outboundHold)
      .mockResolvedValueOnce(returnHold);

    const roundTripPayload = {
      legs: [
        {
          tripId: '11111111-1111-4111-8111-111111111111',
          travelClassId: 'class-ac1',
          originStationId: '22222222-2222-4222-8222-222222222222',
          destinationStationId: '33333333-3333-4333-8333-333333333333',
        },
        {
          tripId: '55555555-5555-4555-8555-555555555555',
          travelClassId: 'class-ac1',
          originStationId: '33333333-3333-4333-8333-333333333333',
          destinationStationId: '22222222-2222-4222-8222-222222222222',
        },
      ],
      groupSize: 2,
    };

    const response = await controller.createBooking(
      roundTripPayload as any,
      { body: roundTripPayload } as any,
    );

    expect(response.status).toBe('PENDING');
    expect(response.legs).toHaveLength(2);

    // Outbound leg: SIDE_BY_SIDE, no split notice
    expect(response.legs[0].allocationOutcome).toBe(AllocationOutcome.SIDE_BY_SIDE);
    expect(response.legs[0].splitNotice).toBeUndefined();
    expect(response.legs[0].seats).toEqual([
      'Passenger · Coach 1 · Seat 1',
      'Passenger · Coach 1 · Seat 2',
    ]);

    // Return leg: SPLIT, with bilingual split notice
    expect(response.legs[1].allocationOutcome).toBe(AllocationOutcome.SPLIT);
    expect(response.legs[1].splitNotice).toEqual(SEATS_SPLIT_NOTICE);
    expect(response.legs[1].splitNotice?.code).toBe('SEATS_SPLIT_NOTICE');
    expect(response.legs[1].seats).toEqual([
      'Passenger · Coach 1 · Seat 1',
      'Passenger · Coach 2 · Seat 1',
    ]);

    // Verification of persistence
    expect(draftDb.has(response.id)).toBe(true);
  });
});
