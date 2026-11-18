import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HttpStatus, NotFoundException, HttpException } from '@nestjs/common';
import { AllocationOutcome, ErrorCode } from '@app/contracts';
import { BookingDraftController } from './booking-draft.controller.js';
import {
  BookingDraftService,
  BookingDraftError,
} from './booking-draft.service.js';
import type {
  CreateBookingDraftDto,
  BookingDraftResponse,
} from './dto/create-booking-draft.dto.js';

describe('BookingDraftController', () => {
  let controller: BookingDraftController;
  let mockService: any;

  beforeEach(() => {
    mockService = {
      createDraft: vi.fn(),
      getDraft: vi.fn(),
    };
    controller = new BookingDraftController(mockService as BookingDraftService);
  });

  describe('createDraft', () => {
    it('delegates to BookingDraftService and returns the draft response on success', async () => {
      const response: BookingDraftResponse = {
        id: 'draft-123',
        userId: 'user-abc',
        status: 'PENDING',
        expiresAt: new Date().toISOString(),
        legs: [
          {
            holdId: 'hold-1',
            tripId: 'trip-1',
            travelClassId: 'class-1',
            allocationOutcome: AllocationOutcome.SIDE_BY_SIDE,
            seats: ['Passenger · Coach 1 · Seat 1'],
          },
        ],
        createdAt: new Date().toISOString(),
      };

      mockService.createDraft.mockResolvedValueOnce(response);

      const dto: CreateBookingDraftDto = {
        userId: 'user-abc',
        legs: [
          {
            tripId: 'trip-1',
            travelClassId: 'class-1',
            originStationId: 'st-cairo',
            destinationStationId: 'st-alex',
          },
        ],
        passengerCount: 1,
      };

      const result = await controller.createDraft(dto);
      expect(result).toEqual(response);
      expect(mockService.createDraft).toHaveBeenCalledWith(dto);
    });

    it('translates INSUFFICIENT_SEATS BookingDraftError to HttpException 409 carrying availableCount', async () => {
      const error = new BookingDraftError(
        ErrorCode.INSUFFICIENT_SEATS,
        'INSUFFICIENT_SEATS',
        2,
      );
      mockService.createDraft.mockRejectedValueOnce(error);

      const dto: CreateBookingDraftDto = {
        userId: 'user-insufficient',
        passengerCount: 3,
      };

      try {
        await controller.createDraft(dto);
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(HttpException);
        const httpErr = err as HttpException;
        expect(httpErr.getStatus()).toBe(HttpStatus.CONFLICT);
        const responseBody = httpErr.getResponse() as Record<string, any>;
        expect(responseBody.code).toBe(ErrorCode.INSUFFICIENT_SEATS);
        expect(responseBody.availableCount).toBe(2);
      }
    });

    it('translates VALIDATION_ERROR BookingDraftError to HttpException 400', async () => {
      const error = new BookingDraftError(
        ErrorCode.VALIDATION_ERROR,
        'Invalid passenger count: 5',
      );
      mockService.createDraft.mockRejectedValueOnce(error);

      const dto: CreateBookingDraftDto = {
        userId: 'user-val',
        passengerCount: 5,
      };

      try {
        await controller.createDraft(dto);
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(HttpException);
        const httpErr = err as HttpException;
        expect(httpErr.getStatus()).toBe(HttpStatus.BAD_REQUEST);
        const responseBody = httpErr.getResponse() as Record<string, any>;
        expect(responseBody.code).toBe(ErrorCode.VALIDATION_ERROR);
      }
    });
  });

  describe('getDraft', () => {
    it('returns draft if found', async () => {
      const draft = {
        id: 'draft-found',
        userId: 'user-1',
        status: 'PENDING',
      };
      mockService.getDraft.mockResolvedValueOnce(draft);

      const result = await controller.getDraft('draft-found');
      expect(result).toEqual(draft);
      expect(mockService.getDraft).toHaveBeenCalledWith('draft-found');
    });

    it('throws NotFoundException if draft not found', async () => {
      mockService.getDraft.mockResolvedValueOnce(null);

      await expect(controller.getDraft('non-existent')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });
});
