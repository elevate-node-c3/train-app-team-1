import { createHash, randomUUID } from 'node:crypto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HttpException, HttpStatus } from '@nestjs/common';
import {
  AllocationOutcome,
  ErrorCode,
  SEATS_SPLIT_NOTICE,
  type CreateHoldRequest,
  type HoldLegInput,
  type HoldSnapshot,
  type ResolveHoldPassengersRequest,
} from '@app/contracts';
import { BookingController } from '../../apps/gateway/src/modules/booking/booking.controller.js';
import { BookingService } from '../../apps/gateway/src/modules/booking/booking.service.js';
import {
  BookingDraftService,
  BookingDraftError,
  type InventoryGrpcService,
} from '../../apps/booking/src/modules/draft/booking-draft.service.js';
import { allocateGroupSeats } from '../../apps/inventory/src/modules/seat-allocation/seat-allocator.js';
import type { AllocatableSeat } from '../../apps/inventory/src/modules/seat-allocation/seat-allocator.types.js';
import {
  BookingDraftStore,
  projectHoldSnapshot,
} from '../../apps/booking/src/modules/draft/booking-draft.store.js';
import { BookingDraftEntity } from '../../apps/booking/src/modules/draft/entities/booking-draft.entity.js';

const OWNER = '99999999-9999-4999-8999-999999999999';
const CLASS = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OUTBOUND: HoldLegInput = {
  tripId: '11111111-1111-4111-8111-111111111111',
  travelClassId: CLASS,
  originStationId: '22222222-2222-4222-8222-222222222222',
  destinationStationId: '33333333-3333-4333-8333-333333333333',
};
const INBOUND: HoldLegInput = {
  tripId: '55555555-5555-4555-8555-555555555555',
  travelClassId: CLASS,
  originStationId: OUTBOUND.destinationStationId,
  destinationStationId: OUTBOUND.originStationId,
};

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
  return seats.filter((seat) => !free.has(seat.seatId)).map((seat) => seat.seatId);
}

// Transport orchestration with real SEAT-2 allocation/projection. PostgreSQL
// atomicity is covered separately in hold-core.int-spec.ts, not by these fakes.
describe('Group seat allocation through the atomic Booking API', () => {
  let controller: BookingController;
  let gatewayBookingService: BookingService;
  let backendDraftService: BookingDraftService;
  let store: BookingDraftStore;
  let mockInventoryService: InventoryGrpcService;
  let mockClsService: any;

  // Stored drafts for in-memory persistence verification
  const draftDb = new Map<string, BookingDraftEntity>();

  const payload = (count: number, legs = [OUTBOUND]) => ({
    bookingKey: randomUUID(),
    passengerIds: Array.from({ length: count }, () => randomUUID()),
    legs,
  });

  function givenAllocations(
    ...allocations: ReturnType<typeof allocateGroupSeats>[]
  ) {
    vi.mocked(mockInventoryService.createHold).mockImplementation(
      async (request: CreateHoldRequest) => {
        const legs = request.legs.map((leg, index) => {
          const result = allocations[index];
          if (!result.success)
            throw new BookingDraftError(ErrorCode.SEAT_TAKEN);
          return {
            ...leg,
            outcome: result.outcome,
            originPosition: 0,
            destinationPosition: 2,
          };
        });
        const assignments = legs.flatMap((leg, legIndex) => {
          const result = allocations[legIndex];
          if (!result.success) throw new Error('Invalid test allocation');
          return result.seats.map((seat, index) => ({
            ...leg,
            passengerRef: request.passengers[index].passengerRef,
            passengerKeyVersion: 1,
            tripSeatId: randomUUID(),
            coachNumber: seat.coachNumber,
            seatNumber: seat.seatNumber,
            rowNumber: seat.rowNumber,
            label: seat.label,
          }));
        });
        return {
          holdId: randomUUID(),
          bookingKey: request.bookingKey,
          ownerId: request.ownerId,
          state: 'HELD',
          version: 1,
          extensionUsed: false,
          serverNow: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 900_000).toISOString(),
          allocationOutcome: legs.some(
            (leg) => leg.outcome === AllocationOutcome.SPLIT,
          )
            ? AllocationOutcome.SPLIT
            : legs[0].outcome,
          legs,
          assignments,
        } satisfies HoldSnapshot;
      },
    );
  }

  beforeEach(() => {
    draftDb.clear();
    vi.stubEnv(
      'BOOKING_INVENTORY_SERVICE_KEY',
      'test-booking-inventory-credential-long-enough',
    );
    vi.stubEnv(
      'BOOKING_IDENTITY_SERVICE_KEY',
      'test-booking-identity-credential-long-enough',
    );
    store = {
      createIntent: vi.fn(
        async (id, userId, requestFingerprint, holdIntent) => {
          const draft = Object.assign(new BookingDraftEntity(), {
            id,
            userId,
            requestFingerprint,
            holdIntent,
            status: 'PENDING',
            createdAt: new Date(),
            passengerSnapshot: null,
            holdFailure: null,
            holdState: null,
            holdId: null,
            holdVersion: 0,
            holdRequested: false,
            releaseRequested: false,
            holdSnapshot: null,
            holdServerNow: null,
            expiresAt: null,
            legs: [],
            extensionUsed: false,
            reconciliationPending: true,
          });
          draftDb.set(id, draft);
          return draft;
        },
      ),
      rememberPassengers: vi.fn(async (id, _owner, passengers) => {
        const draft = draftDb.get(id)!;
        draft.passengerSnapshot ??= passengers;
        return draft;
      }),
      requestHold: vi.fn(async (id) => {
        const draft = draftDb.get(id)!;
        const alreadyRequested = draft.holdRequested;
        draft.holdRequested = true;
        return { draft, alreadyRequested };
      }),
      applySnapshot: vi.fn(async (snapshot) => {
        const draft = draftDb.get(snapshot.bookingKey)!;
        projectHoldSnapshot(draft, snapshot);
        return draft;
      }),
      rejectIntent: vi.fn(async (id, _owner, failure) => {
        const draft = draftDb.get(id)!;
        draft.holdFailure = failure;
        draft.status = 'FAILED';
        return draft;
      }),
    } as unknown as BookingDraftStore;

    mockInventoryService = {
      createHold: vi.fn(),
      getHold: vi.fn(),
      releaseHold: vi.fn(),
      extendHold: vi.fn(),
    };

    backendDraftService = new BookingDraftService(
      store,
      mockInventoryService,
      {
        resolveHoldPassengers: vi.fn(
          async (request: ResolveHoldPassengersRequest) => ({
            passengers: request.passengerRefs.map((passengerRef) => ({
              passengerRef,
              displayName: 'Passenger',
              maskedNationalId: '**********1234',
              identities: request.tripIds.map((tripId) => ({
                tripId,
                passengerKeyVersion: 1,
                passengerToken: createHash('sha256')
                  .update(`${tripId}:${passengerRef}`)
                  .digest('hex'),
              })),
            })),
          }),
        ),
      },
      { get: () => OWNER } as never,
    );

    // Wire Gateway BookingService to call backend BookingDraftService
    const mockBookingClient = {
      createDraft: vi.fn(async (dto: any, userId: string) => {
        return backendDraftService.createDraft({ ...dto, userId });
      }),
    };

    gatewayBookingService = new BookingService(mockBookingClient as any);

    mockClsService = {
      get: vi.fn().mockReturnValue(OWNER),
    };

    controller = new BookingController(gatewayBookingService, mockClsService);
  });

  afterEach(() => vi.unstubAllEnvs());

  it('Flow 1: Group of 2 gets side-by-side seats (Tier 1)', async () => {
    // Inventory setup: Coach 1 has free adjacent seats (1, 2)
    const seats = createStandardCoach(1, 5);
    const free = ['1:1', '1:2', '1:3', '1:4'];
    const allocResult = allocateGroupSeats({
      seats,
      occupiedSeatIds: occupiedExcept(seats, free),
      groupSize: 2,
    });

    expect(allocResult.success).toBe(true);
    if (!allocResult.success) throw new Error('Allocation failed');
    expect(allocResult.outcome).toBe(AllocationOutcome.SIDE_BY_SIDE);

    givenAllocations(allocResult);
    const clientPayload = payload(2);

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
    const free = ['1:1', '1:4', '1:5']; // isolated seats in Coach 1
    const allocResult = allocateGroupSeats({
      seats,
      occupiedSeatIds: occupiedExcept(seats, free),
      groupSize: 3,
    });

    expect(allocResult.success).toBe(true);
    if (!allocResult.success) throw new Error('Allocation failed');
    expect(allocResult.outcome).toBe(AllocationOutcome.SAME_COACH);
    expect(allocResult.seats.every((s) => s.coachNumber === 1)).toBe(true);

    givenAllocations(allocResult);
    const clientPayload = payload(3);

    const response = await controller.createBooking(
      clientPayload as any,
      { body: clientPayload } as any,
    );

    expect(response.legs[0].allocationOutcome).toBe(
      AllocationOutcome.SAME_COACH,
    );
    expect(response.legs[0].splitNotice).toBeUndefined();
    expect(response.legs[0].seats).toHaveLength(3);
    for (const seatLabel of response.legs[0].seats) {
      expect(seatLabel).toContain('Coach 1');
    }
  });

  it('Flow 3: Group of 4 split across minimal coaches carries SEATS_SPLIT_NOTICE (Tier 3)', async () => {
    // Coach 1 has 2 seats; Coach 2 has 2 seats; neither can accommodate all 4
    const seats = [...createStandardCoach(1, 5), ...createStandardCoach(2, 5)];
    const free = ['1:1', '1:2', '2:1', '2:2'];
    const allocResult = allocateGroupSeats({
      seats,
      occupiedSeatIds: occupiedExcept(seats, free),
      groupSize: 4,
    });

    expect(allocResult.success).toBe(true);
    if (!allocResult.success) throw new Error('Allocation failed');
    expect(allocResult.outcome).toBe(AllocationOutcome.SPLIT);

    givenAllocations(allocResult);
    const clientPayload = payload(4);

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
    expect(mockInventoryService.createHold).not.toHaveBeenCalled();
    expect(store.createIntent).not.toHaveBeenCalled();
  });

  it('Flow 5: Round trip with independent leg outcomes (outbound side-by-side, return split)', async () => {
    const outboundSeats = createStandardCoach(1);
    const inboundSeats = [
      ...createStandardCoach(1),
      ...createStandardCoach(2),
    ];
    givenAllocations(
      allocateGroupSeats({
        seats: outboundSeats,
        occupiedSeatIds: occupiedExcept(outboundSeats, ['1:1', '1:2']),
        groupSize: 2,
      }),
      allocateGroupSeats({
        seats: inboundSeats,
        occupiedSeatIds: occupiedExcept(inboundSeats, ['1:1', '2:1']),
        groupSize: 2,
      }),
    );
    const roundTripPayload = payload(2, [OUTBOUND, INBOUND]);

    const response = await controller.createBooking(
      roundTripPayload as any,
      { body: roundTripPayload } as any,
    );

    expect(response.status).toBe('PENDING');
    expect(response.legs).toHaveLength(2);

    // Outbound leg: SIDE_BY_SIDE, no split notice
    expect(response.legs[0].allocationOutcome).toBe(
      AllocationOutcome.SIDE_BY_SIDE,
    );
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
    expect(mockInventoryService.createHold).toHaveBeenCalledOnce();
    expect(
      vi.mocked(mockInventoryService.createHold).mock.calls[0][0].legs,
    ).toHaveLength(2);
    expect(mockInventoryService.releaseHold).not.toHaveBeenCalled();
  });

  it('a failed return leg is one atomic refusal, not two calls with compensation', async () => {
    vi.mocked(mockInventoryService.createHold).mockRejectedValue(
      new BookingDraftError(ErrorCode.SEAT_TAKEN),
    );
    await expect(
      controller.createBooking(payload(2, [OUTBOUND, INBOUND])),
    ).rejects.toMatchObject({ code: ErrorCode.SEAT_TAKEN });
    expect(mockInventoryService.createHold).toHaveBeenCalledOnce();
    expect(mockInventoryService.releaseHold).not.toHaveBeenCalled();
    expect([...draftDb.values()][0].status).toBe('FAILED');
    expect([...draftDb.values()][0].legs).toEqual([]);
  });
});
