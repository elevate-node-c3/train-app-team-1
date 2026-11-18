import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  AllocationOutcome,
  ErrorCode,
  SEATS_SPLIT_NOTICE,
  type HoldSeatsResponse,
  type ReleaseSeatsResponse,
} from '@app/contracts';
import {
  BookingDraftService,
  type InventoryGrpcService,
} from './booking-draft.service.js';
import type { CreateBookingDraftDto } from './dto/create-booking-draft.dto.js';

describe('BookingDraftService', () => {
  let service: BookingDraftService;
  let mockRepository: any;
  let mockInventoryService: InventoryGrpcService;

  beforeEach(() => {
    mockRepository = {
      create: vi.fn((entity: any) => ({ ...entity })),
      save: vi.fn((entity: any) => Promise.resolve({ ...entity })),
      findOne: vi.fn(),
    };

    mockInventoryService = {
      holdSeats: vi.fn(),
      releaseSeats: vi.fn(),
    } as unknown as InventoryGrpcService;

    service = new BookingDraftService(mockRepository, mockInventoryService);
  });

  describe('Single-Leg Draft', () => {
    it('creates a single-leg draft with outcome SIDE_BY_SIDE and ttlSeconds = 600', async () => {
      const holdRes: HoldSeatsResponse = {
        holdId: 'hold-single-1',
        allocationOutcome: AllocationOutcome.SIDE_BY_SIDE,
        seats: [
          {
            seatId: 'seat-1',
            coachNumber: 5,
            seatNumber: '44',
            rowNumber: 10,
            label: 'Coach 5 · Seat 44',
          },
          {
            seatId: 'seat-2',
            coachNumber: 5,
            seatNumber: '45',
            rowNumber: 10,
            label: 'Coach 5 · Seat 45',
          },
        ],
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
      };

      vi.mocked(mockInventoryService.holdSeats).mockResolvedValueOnce(holdRes as any);

      const dto: CreateBookingDraftDto = {
        userId: 'user-123',
        legs: [
          {
            tripId: 'trip-1',
            travelClassId: 'class-first',
            originStationId: 'st-cairo',
            destinationStationId: 'st-alex',
          },
        ],
        passengerCount: 2,
      };

      const result = await service.createDraft(dto);

      expect(mockInventoryService.holdSeats).toHaveBeenCalledTimes(1);
      expect(mockInventoryService.holdSeats).toHaveBeenCalledWith(
        expect.objectContaining({
          tripId: 'trip-1',
          travelClassId: 'class-first',
          originStationId: 'st-cairo',
          destinationStationId: 'st-alex',
          groupSize: 2,
          ttlSeconds: 600,
        }),
      );

      expect(result.status).toBe('PENDING');
      expect(result.legs).toHaveLength(1);
      expect(result.legs[0].holdId).toBe('hold-single-1');
      expect(result.legs[0].allocationOutcome).toBe(AllocationOutcome.SIDE_BY_SIDE);
      expect(result.legs[0].seats).toEqual([
        'Passenger · Coach 5 · Seat 44',
        'Passenger · Coach 5 · Seat 45',
      ]);
      expect(result.legs[0].splitNotice).toBeUndefined();

      expect(mockRepository.save).toHaveBeenCalledTimes(1);
      expect(mockRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-123',
          status: 'PENDING',
        }),
      );
    });

    it('creates a single-leg draft with outcome SPLIT carrying bilingual splitNotice', async () => {
      const holdRes: HoldSeatsResponse = {
        holdId: 'hold-split-1',
        allocationOutcome: AllocationOutcome.SPLIT,
        seats: [
          {
            seatId: 'seat-10',
            coachNumber: 1,
            seatNumber: '1A',
            rowNumber: 1,
            label: 'Coach 1 · Seat 1A',
          },
          {
            seatId: 'seat-20',
            coachNumber: 2,
            seatNumber: '2B',
            rowNumber: 2,
            label: 'Coach 2 · Seat 2B',
          },
        ],
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
        splitNotice: SEATS_SPLIT_NOTICE,
      };

      vi.mocked(mockInventoryService.holdSeats).mockResolvedValueOnce(holdRes as any);

      const dto: CreateBookingDraftDto = {
        userId: 'user-456',
        legs: [
          {
            tripId: 'trip-2',
            travelClassId: 'class-economy',
            originStationId: 'st-cairo',
            destinationStationId: 'st-aswan',
          },
        ],
        passengers: [{ fullName: 'Passenger' }, { fullName: 'Passenger' }],
      };

      const result = await service.createDraft(dto);

      expect(result.status).toBe('PENDING');
      expect(result.legs[0].allocationOutcome).toBe(AllocationOutcome.SPLIT);
      expect(result.legs[0].splitNotice).toEqual(SEATS_SPLIT_NOTICE);
      expect(result.legs[0].splitNotice?.code).toBe('SEATS_SPLIT_NOTICE');
      expect(result.legs[0].splitNotice?.message).toBe(
        'تم توزيع المقاعد عبر أكثر من عربة لعدم توفر مقاعد متجاورة كافية',
      );
      expect(result.legs[0].splitNotice?.messageEn).toBe(
        'Seats have been split across coaches because consecutive seats were unavailable',
      );
    });

    it('formats assigned seats with custom passenger names when provided', async () => {
      const holdRes: HoldSeatsResponse = {
        holdId: 'hold-custom-names',
        allocationOutcome: AllocationOutcome.SIDE_BY_SIDE,
        seats: [
          {
            seatId: 'seat-1',
            coachNumber: 3,
            seatNumber: '12',
            rowNumber: 3,
            label: 'Coach 3 · Seat 12',
          },
          {
            seatId: 'seat-2',
            coachNumber: 3,
            seatNumber: '13',
            rowNumber: 3,
            label: 'Coach 3 · Seat 13',
          },
        ],
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
      };

      vi.mocked(mockInventoryService.holdSeats).mockResolvedValueOnce(holdRes as any);

      const dto: CreateBookingDraftDto = {
        userId: 'user-789',
        legs: [
          {
            tripId: 'trip-3',
            travelClassId: 'class-first',
            originStationId: 'st-cairo',
            destinationStationId: 'st-alex',
          },
        ],
        passengers: [
          { fullName: 'Ahmed Hassan' },
          { fullName: 'Mona Mahmoud' },
        ],
      };

      const result = await service.createDraft(dto);

      expect(result.legs[0].seats).toEqual([
        'Ahmed Hassan · Coach 3 · Seat 12',
        'Mona Mahmoud · Coach 3 · Seat 13',
      ]);
    });
  });

  describe('Multi-Leg (Round Trip) Draft', () => {
    it('succeeds with independent outcomes on both legs (Leg 1 SIDE_BY_SIDE, Leg 2 SPLIT)', async () => {
      const leg1HoldRes: HoldSeatsResponse = {
        holdId: 'hold-outbound',
        allocationOutcome: AllocationOutcome.SIDE_BY_SIDE,
        seats: [
          {
            seatId: 'seat-1',
            coachNumber: 5,
            seatNumber: '44',
            rowNumber: 10,
            label: 'Coach 5 · Seat 44',
          },
        ],
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
      };

      const leg2HoldRes: HoldSeatsResponse = {
        holdId: 'hold-return',
        allocationOutcome: AllocationOutcome.SPLIT,
        seats: [
          {
            seatId: 'seat-99',
            coachNumber: 2,
            seatNumber: '8',
            rowNumber: 2,
            label: 'Coach 2 · Seat 8',
          },
        ],
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
        splitNotice: SEATS_SPLIT_NOTICE,
      };

      vi.mocked(mockInventoryService.holdSeats)
        .mockResolvedValueOnce(leg1HoldRes as any)
        .mockResolvedValueOnce(leg2HoldRes as any);

      const dto: CreateBookingDraftDto = {
        userId: 'user-roundtrip',
        legs: [
          {
            tripId: 'trip-outbound',
            travelClassId: 'class-first',
            originStationId: 'st-cairo',
            destinationStationId: 'st-alex',
          },
          {
            tripId: 'trip-return',
            travelClassId: 'class-first',
            originStationId: 'st-alex',
            destinationStationId: 'st-cairo',
          },
        ],
        passengerCount: 1,
      };

      const result = await service.createDraft(dto);

      expect(mockInventoryService.holdSeats).toHaveBeenCalledTimes(2);
      expect(mockInventoryService.releaseSeats).not.toHaveBeenCalled();

      expect(result.status).toBe('PENDING');
      expect(result.legs).toHaveLength(2);

      // Leg 1: SIDE_BY_SIDE, no split notice
      expect(result.legs[0].holdId).toBe('hold-outbound');
      expect(result.legs[0].allocationOutcome).toBe(AllocationOutcome.SIDE_BY_SIDE);
      expect(result.legs[0].seats).toEqual(['Passenger · Coach 5 · Seat 44']);
      expect(result.legs[0].splitNotice).toBeUndefined();

      // Leg 2: SPLIT, with bilingual split notice
      expect(result.legs[1].holdId).toBe('hold-return');
      expect(result.legs[1].allocationOutcome).toBe(AllocationOutcome.SPLIT);
      expect(result.legs[1].seats).toEqual(['Passenger · Coach 2 · Seat 8']);
      expect(result.legs[1].splitNotice).toEqual(SEATS_SPLIT_NOTICE);
    });

    it('compensates via releaseSeats when return leg fails with INSUFFICIENT_SEATS and rejects draft', async () => {
      const leg1HoldRes: HoldSeatsResponse = {
        holdId: 'hold-leg1-ok',
        allocationOutcome: AllocationOutcome.SIDE_BY_SIDE,
        seats: [
          {
            seatId: 'seat-1',
            coachNumber: 1,
            seatNumber: '1',
            rowNumber: 1,
            label: 'Coach 1 · Seat 1',
          },
        ],
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
      };

      const leg2Error = Object.assign(new Error('INSUFFICIENT_SEATS'), {
        code: ErrorCode.INSUFFICIENT_SEATS,
        availableCount: 0,
      });

      vi.mocked(mockInventoryService.holdSeats)
        .mockResolvedValueOnce(leg1HoldRes as any)
        .mockRejectedValueOnce(leg2Error);

      const releaseRes: ReleaseSeatsResponse = { success: true };
      vi.mocked(mockInventoryService.releaseSeats).mockResolvedValueOnce(releaseRes as any);

      const dto: CreateBookingDraftDto = {
        userId: 'user-partial-fail',
        legs: [
          {
            tripId: 'trip-leg1',
            travelClassId: 'class-first',
            originStationId: 'st-cairo',
            destinationStationId: 'st-alex',
          },
          {
            tripId: 'trip-leg2',
            travelClassId: 'class-first',
            originStationId: 'st-alex',
            destinationStationId: 'st-cairo',
          },
        ],
        passengerCount: 1,
      };

      await expect(service.createDraft(dto)).rejects.toMatchObject({
        code: ErrorCode.INSUFFICIENT_SEATS,
        availableCount: 0,
      });

      // Saga compensation invoked for Leg 1
      expect(mockInventoryService.releaseSeats).toHaveBeenCalledTimes(1);
      expect(mockInventoryService.releaseSeats).toHaveBeenCalledWith({
        holdId: 'hold-leg1-ok',
      });

      // Failed draft record is saved with status FAILED
      expect(mockRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-partial-fail',
          status: 'FAILED',
        }),
      );
    });

    it('compensates multiple previously held legs when a subsequent leg fails', async () => {
      const leg1Hold: HoldSeatsResponse = {
        holdId: 'hold-1',
        allocationOutcome: AllocationOutcome.SIDE_BY_SIDE,
        seats: [],
        expiresAt: new Date().toISOString(),
      };
      const leg2Hold: HoldSeatsResponse = {
        holdId: 'hold-2',
        allocationOutcome: AllocationOutcome.SAME_COACH,
        seats: [],
        expiresAt: new Date().toISOString(),
      };

      const leg3Error = Object.assign(new Error('SEAT_ALREADY_TAKEN'), {
        code: ErrorCode.SEAT_ALREADY_TAKEN,
      });

      vi.mocked(mockInventoryService.holdSeats)
        .mockResolvedValueOnce(leg1Hold as any)
        .mockResolvedValueOnce(leg2Hold as any)
        .mockRejectedValueOnce(leg3Error);

      vi.mocked(mockInventoryService.releaseSeats).mockResolvedValue({ success: true } as any);

      const dto: CreateBookingDraftDto = {
        userId: 'user-multi-leg',
        legs: [
          { tripId: 't1', travelClassId: 'c1', originStationId: 's1', destinationStationId: 's2' },
          { tripId: 't2', travelClassId: 'c1', originStationId: 's2', destinationStationId: 's3' },
          { tripId: 't3', travelClassId: 'c1', originStationId: 's3', destinationStationId: 's4' },
        ],
        passengerCount: 2,
      };

      await expect(service.createDraft(dto)).rejects.toMatchObject({
        code: ErrorCode.SEAT_ALREADY_TAKEN,
      });

      expect(mockInventoryService.releaseSeats).toHaveBeenCalledTimes(2);
      expect(mockInventoryService.releaseSeats).toHaveBeenCalledWith({ holdId: 'hold-1' });
      expect(mockInventoryService.releaseSeats).toHaveBeenCalledWith({ holdId: 'hold-2' });
    });
  });

  describe('Passenger Count Validation', () => {
    it('rejects when passenger count is < 1', async () => {
      const dtoZero: CreateBookingDraftDto = {
        userId: 'user-val-0',
        legs: [
          { tripId: 't1', travelClassId: 'c1', originStationId: 's1', destinationStationId: 's2' },
        ],
        passengerCount: 0,
      };

      await expect(service.createDraft(dtoZero)).rejects.toMatchObject({
        code: ErrorCode.VALIDATION_ERROR,
      });

      const dtoEmptyPassengers: CreateBookingDraftDto = {
        userId: 'user-val-empty',
        legs: [
          { tripId: 't1', travelClassId: 'c1', originStationId: 's1', destinationStationId: 's2' },
        ],
        passengers: [],
      };

      await expect(service.createDraft(dtoEmptyPassengers)).rejects.toMatchObject({
        code: ErrorCode.VALIDATION_ERROR,
      });

      expect(mockInventoryService.holdSeats).not.toHaveBeenCalled();
    });

    it('rejects when passenger count is > 4', async () => {
      const dtoFive: CreateBookingDraftDto = {
        userId: 'user-val-5',
        legs: [
          { tripId: 't1', travelClassId: 'c1', originStationId: 's1', destinationStationId: 's2' },
        ],
        passengerCount: 5,
      };

      await expect(service.createDraft(dtoFive)).rejects.toMatchObject({
        code: ErrorCode.VALIDATION_ERROR,
      });

      const dtoFivePassengers: CreateBookingDraftDto = {
        userId: 'user-val-five-passengers',
        legs: [
          { tripId: 't1', travelClassId: 'c1', originStationId: 's1', destinationStationId: 's2' },
        ],
        passengers: [
          { fullName: 'P1' },
          { fullName: 'P2' },
          { fullName: 'P3' },
          { fullName: 'P4' },
          { fullName: 'P5' },
        ],
      };

      await expect(service.createDraft(dtoFivePassengers)).rejects.toMatchObject({
        code: ErrorCode.VALIDATION_ERROR,
      });

      expect(mockInventoryService.holdSeats).not.toHaveBeenCalled();
    });
  });
});
