import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HttpException, HttpStatus } from '@nestjs/common';
import {
  AllocationOutcome,
  ErrorCode,
  SEATS_SPLIT_NOTICE,
} from '@app/contracts';
import { ACCESS_LEVEL_KEY } from '@app/common';
import { BookingController } from './booking.controller.js';
import { BookingService } from './booking.service.js';
import {
  findForbiddenSeatSelectionKey,
  NoSeatSelectionPipe,
} from './dto/create-booking.dto.js';

describe('BookingController & Route Validation', () => {
  let controller: BookingController;
  let mockBookingService: {
    createBooking: ReturnType<typeof vi.fn>;
  };
  let mockClsService: {
    get: ReturnType<typeof vi.fn>;
  };
  let pipe: NoSeatSelectionPipe;

  beforeEach(() => {
    mockBookingService = {
      createBooking: vi.fn(),
    };
    mockClsService = {
      get: vi.fn().mockReturnValue('user-acc-123'),
    };
    controller = new BookingController(
      mockBookingService as unknown as BookingService,
      // Checkout is not reached from these draft-creation tests.
      {} as never,
      mockClsService as any,
    );
    pipe = new NoSeatSelectionPipe();
  });

  describe('Route Security & Metadata (BR-01, R4)', () => {
    it('requires the existing bookable access level at the single booking entry', () => {
      const classLevel = Reflect.getMetadata(
        ACCESS_LEVEL_KEY,
        BookingController,
      );
      const handlerLevel = Reflect.getMetadata(
        ACCESS_LEVEL_KEY,
        BookingController.prototype.createBooking,
      );
      expect(classLevel).toBe('bookable');
      expect(handlerLevel).toBe('bookable');
    });
  });

  describe('The Server Allocates: Ban on seat & coach parameters (BR-25, D2)', () => {
    const forbiddenPayloads = [
      {
        name: 'seatId at root',
        body: {
          tripId: '11111111-1111-4111-8111-111111111111',
          travelClassId: '22222222-2222-4222-8222-222222222222',
          originStationId: '33333333-3333-4333-8333-333333333333',
          destinationStationId: '44444444-4444-4444-8444-444444444444',
          seatId: 'seat-uuid-12',
          groupSize: 2,
        },
        expectedKey: 'seatId',
      },
      {
        name: 'coachNumber at root',
        body: {
          tripId: '11111111-1111-4111-8111-111111111111',
          travelClassId: '22222222-2222-4222-8222-222222222222',
          originStationId: '33333333-3333-4333-8333-333333333333',
          destinationStationId: '44444444-4444-4444-8444-444444444444',
          coachNumber: 3,
          groupSize: 2,
        },
        expectedKey: 'coachNumber',
      },
      {
        name: 'seatNumber at root',
        body: {
          tripId: '11111111-1111-4111-8111-111111111111',
          travelClassId: '22222222-2222-4222-8222-222222222222',
          originStationId: '33333333-3333-4333-8333-333333333333',
          destinationStationId: '44444444-4444-4444-8444-444444444444',
          seatNumber: '14B',
          groupSize: 2,
        },
        expectedKey: 'seatNumber',
      },
      {
        name: 'coach at root',
        body: {
          tripId: '11111111-1111-4111-8111-111111111111',
          travelClassId: '22222222-2222-4222-8222-222222222222',
          originStationId: '33333333-3333-4333-8333-333333333333',
          destinationStationId: '44444444-4444-4444-8444-444444444444',
          coach: 5,
          groupSize: 2,
        },
        expectedKey: 'coach',
      },
      {
        name: 'coachId at root',
        body: {
          tripId: '11111111-1111-4111-8111-111111111111',
          travelClassId: '22222222-2222-4222-8222-222222222222',
          originStationId: '33333333-3333-4333-8333-333333333333',
          destinationStationId: '44444444-4444-4444-8444-444444444444',
          coachId: 'coach-uuid-1',
          groupSize: 2,
        },
        expectedKey: 'coachId',
      },
      {
        name: 'seatId inside passengers array',
        body: {
          tripId: '11111111-1111-4111-8111-111111111111',
          travelClassId: '22222222-2222-4222-8222-222222222222',
          originStationId: '33333333-3333-4333-8333-333333333333',
          destinationStationId: '44444444-4444-4444-8444-444444444444',
          passengers: [{ fullName: 'Passenger 1', seatId: 'seat-uuid-22' }],
        },
        expectedKey: 'seatId',
      },
      {
        name: 'coachNumber inside passengers array',
        body: {
          tripId: '11111111-1111-4111-8111-111111111111',
          travelClassId: '22222222-2222-4222-8222-222222222222',
          originStationId: '33333333-3333-4333-8333-333333333333',
          destinationStationId: '44444444-4444-4444-8444-444444444444',
          passengers: [{ fullName: 'Passenger 1', coachNumber: 4 }],
        },
        expectedKey: 'coachNumber',
      },
      {
        name: 'coach inside legs array',
        body: {
          legs: [
            {
              tripId: '11111111-1111-4111-8111-111111111111',
              travelClassId: '22222222-2222-4222-8222-222222222222',
              originStationId: '33333333-3333-4333-8333-333333333333',
              destinationStationId: '44444444-4444-4444-8444-444444444444',
              coach: 2,
            },
          ],
          groupSize: 2,
        },
        expectedKey: 'coach',
      },
      {
        name: 'seatNumber inside legs array',
        body: {
          legs: [
            {
              tripId: '11111111-1111-4111-8111-111111111111',
              travelClassId: '22222222-2222-4222-8222-222222222222',
              originStationId: '33333333-3333-4333-8333-333333333333',
              destinationStationId: '44444444-4444-4444-8444-444444444444',
              seatNumber: '22',
            },
          ],
          groupSize: 2,
        },
        expectedKey: 'seatNumber',
      },
    ];

    it.each(forbiddenPayloads)(
      'rejects $name with HTTP 400 INVALID_PAYLOAD in scanner',
      ({ body, expectedKey }) => {
        const found = findForbiddenSeatSelectionKey(body);
        expect(found).toBe(expectedKey);
      },
    );

    it.each(forbiddenPayloads)(
      'pipe rejects $name with HTTP 400 and ErrorCode.INVALID_PAYLOAD',
      ({ body }) => {
        expect(() => {
          pipe.transform(body, { type: 'body' });
        }).toThrowError(HttpException);

        try {
          pipe.transform(body, { type: 'body' });
        } catch (error) {
          const httpError = error as HttpException;
          expect(httpError.getStatus()).toBe(HttpStatus.BAD_REQUEST);
          const response = httpError.getResponse() as Record<string, unknown>;
          expect(response.code).toBe(ErrorCode.INVALID_PAYLOAD);
        }
      },
    );

    it.each(forbiddenPayloads)(
      'controller rejects $name with HTTP 400 INVALID_PAYLOAD and never calls bookingService',
      async ({ body }) => {
        await expect(
          controller.createBooking(body as any, { body } as any),
        ).rejects.toThrowError(HttpException);

        try {
          await controller.createBooking(body as any, { body } as any);
        } catch (error) {
          const httpError = error as HttpException;
          expect(httpError.getStatus()).toBe(HttpStatus.BAD_REQUEST);
          const response = httpError.getResponse() as Record<string, unknown>;
          expect(response.code).toBe(ErrorCode.INVALID_PAYLOAD);
        }

        expect(mockBookingService.createBooking).not.toHaveBeenCalled();
      },
    );
  });

  describe('Booking Forwarding & Successful Draft Assembly', () => {
    it('forwards valid single-leg booking draft and returns HTTP 201 response', async () => {
      const validDto = {
        bookingKey: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        passengerIds: [
          'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
          'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2',
        ],
        tripId: '11111111-1111-4111-8111-111111111111',
        travelClassId: '22222222-2222-4222-8222-222222222222',
        originStationId: '33333333-3333-4333-8333-333333333333',
        destinationStationId: '44444444-4444-4444-8444-444444444444',
      };

      const expectedDraft = {
        id: 'draft-uuid-1',
        userId: 'user-acc-123',
        status: 'PENDING',
        expiresAt: new Date().toISOString(),
        legs: [
          {
            holdId: 'hold-1',
            tripId: validDto.tripId,
            travelClassId: validDto.travelClassId,
            originStationId: validDto.originStationId,
            destinationStationId: validDto.destinationStationId,
            allocationOutcome: AllocationOutcome.SIDE_BY_SIDE,
            seats: [
              'Passenger · Coach 5 · Seat 44',
              'Passenger · Coach 5 · Seat 45',
            ],
            expiresAt: new Date().toISOString(),
          },
        ],
        createdAt: new Date().toISOString(),
      };

      mockBookingService.createBooking.mockResolvedValueOnce(expectedDraft);

      const result = await controller.createBooking(
        validDto as any,
        { body: validDto } as any,
      );

      expect(mockBookingService.createBooking).toHaveBeenCalledWith(
        validDto,
        'user-acc-123',
      );
      expect(result).toEqual(expectedDraft);
      expect(result.legs[0].allocationOutcome).toBe(
        AllocationOutcome.SIDE_BY_SIDE,
      );
      expect(result.legs[0].seats).toEqual([
        'Passenger · Coach 5 · Seat 44',
        'Passenger · Coach 5 · Seat 45',
      ]);
    });

    it('forwards valid round-trip and surfaces splitNotice on return leg only', async () => {
      const roundTripDto = {
        bookingKey: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        passengerIds: [
          'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
          'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2',
          'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3',
          'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4',
        ],
        legs: [
          {
            tripId: '11111111-1111-4111-8111-111111111111',
            travelClassId: '22222222-2222-4222-8222-222222222222',
            originStationId: '33333333-3333-4333-8333-333333333333',
            destinationStationId: '44444444-4444-4444-8444-444444444444',
          },
          {
            tripId: '55555555-5555-4555-8555-555555555555',
            travelClassId: '22222222-2222-4222-8222-222222222222',
            originStationId: '44444444-4444-4444-8444-444444444444',
            destinationStationId: '33333333-3333-4333-8333-333333333333',
          },
        ],
        groupSize: 4,
      };

      const expectedDraft = {
        id: 'draft-roundtrip-1',
        userId: 'user-acc-123',
        status: 'PENDING',
        expiresAt: new Date().toISOString(),
        legs: [
          {
            holdId: 'hold-outbound',
            tripId: roundTripDto.legs[0].tripId,
            travelClassId: roundTripDto.legs[0].travelClassId,
            originStationId: roundTripDto.legs[0].originStationId,
            destinationStationId: roundTripDto.legs[0].destinationStationId,
            allocationOutcome: AllocationOutcome.SIDE_BY_SIDE,
            seats: [
              'Passenger · Coach 1 · Seat 1',
              'Passenger · Coach 1 · Seat 2',
              'Passenger · Coach 1 · Seat 3',
              'Passenger · Coach 1 · Seat 4',
            ],
            expiresAt: new Date().toISOString(),
          },
          {
            holdId: 'hold-return',
            tripId: roundTripDto.legs[1].tripId,
            travelClassId: roundTripDto.legs[1].travelClassId,
            originStationId: roundTripDto.legs[1].originStationId,
            destinationStationId: roundTripDto.legs[1].destinationStationId,
            allocationOutcome: AllocationOutcome.SPLIT,
            seats: [
              'Passenger · Coach 1 · Seat 1',
              'Passenger · Coach 1 · Seat 2',
              'Passenger · Coach 2 · Seat 1',
              'Passenger · Coach 2 · Seat 2',
            ],
            splitNotice: SEATS_SPLIT_NOTICE,
            expiresAt: new Date().toISOString(),
          },
        ],
        createdAt: new Date().toISOString(),
      };

      mockBookingService.createBooking.mockResolvedValueOnce(expectedDraft);

      const result = await controller.createBooking(
        roundTripDto as any,
        { body: roundTripDto } as any,
      );

      expect(result.legs[0].allocationOutcome).toBe(
        AllocationOutcome.SIDE_BY_SIDE,
      );
      expect(result.legs[0].splitNotice).toBeUndefined();
      expect(result.legs[1].allocationOutcome).toBe(AllocationOutcome.SPLIT);
      expect(result.legs[1].splitNotice).toEqual(SEATS_SPLIT_NOTICE);
      expect(result.legs[1].splitNotice?.messageEn).toContain(
        'Seats have been split across coaches',
      );
    });
  });

  describe('Downstream Business Error Translation', () => {
    it('propagates downstream INSUFFICIENT_SEATS as HTTP 409 Conflict', async () => {
      mockBookingService.createBooking.mockRejectedValueOnce(
        new HttpException(
          {
            code: ErrorCode.INSUFFICIENT_SEATS,
            message: 'Not enough seats available',
            availableCount: 1,
          },
          HttpStatus.CONFLICT,
        ),
      );

      const validDto = {
        bookingKey: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        passengerIds: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'],
        tripId: '11111111-1111-4111-8111-111111111111',
        travelClassId: '22222222-2222-4222-8222-222222222222',
        originStationId: '33333333-3333-4333-8333-333333333333',
        destinationStationId: '44444444-4444-4444-8444-444444444444',
        groupSize: 3,
      };

      await expect(
        controller.createBooking(validDto as any, { body: validDto } as any),
      ).rejects.toThrowError(HttpException);

      try {
        await controller.createBooking(
          validDto as any,
          { body: validDto } as any,
        );
      } catch (error) {
        const httpError = error as HttpException;
        expect(httpError.getStatus()).toBe(HttpStatus.CONFLICT);
        const res = httpError.getResponse() as Record<string, unknown>;
        expect(res.code).toBe(ErrorCode.INSUFFICIENT_SEATS);
      }
    });
  });

  it('never falls back to a body-supplied owner when caller context is absent', async () => {
    mockClsService.get.mockReturnValue(undefined);
    await expect(
      controller.createBooking({ userId: 'attacker' } as never),
    ).rejects.toMatchObject({ status: 401 });
    expect(mockBookingService.createBooking).not.toHaveBeenCalled();
  });

  it('requires actual saved passenger references instead of count-only requests', async () => {
    await expect(
      controller.createBooking({
        bookingKey: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        groupSize: 2,
      } as never),
    ).rejects.toMatchObject({ status: 400 });
    expect(mockBookingService.createBooking).not.toHaveBeenCalled();
  });

  it('uses an immutable Idempotency-Key header and the authenticated owner', async () => {
    const bookingKey = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const dto = {
      passengerIds: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'],
      userId: 'spoofed',
    };
    await controller.createBooking(dto as never, {
      headers: { 'idempotency-key': bookingKey },
    });
    expect(mockBookingService.createBooking).toHaveBeenCalledWith(
      { ...dto, bookingKey },
      'user-acc-123',
    );
  });

  it('rejects disagreeing body/header keys without calling Booking', async () => {
    const dto = {
      bookingKey: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      passengerIds: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'],
    };
    await expect(
      controller.createBooking(dto, {
        headers: { 'idempotency-key': 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(mockBookingService.createBooking).not.toHaveBeenCalled();
  });
});
