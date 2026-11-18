import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HttpException,
  HttpStatus,
  NotFoundException,
  UnauthorizedException,
  type ExecutionContext,
} from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants.js';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ErrorCode } from '@app/contracts';
import { BookingDraftController } from './booking-draft.controller.js';
import {
  BookingDraftError,
  BookingDraftService,
} from './booking-draft.service.js';
import { BookingIngressGuard } from './booking-ingress.guard.js';
import { CreateBookingDraftDto } from './dto/create-booking-draft.dto.js';
import {
  OWNER_ID,
  PASSENGER_IDS,
  draftInput,
} from './testing/hold-fixtures.js';

describe('BookingDraftController', () => {
  let controller: BookingDraftController;
  let service: {
    createDraft: ReturnType<typeof vi.fn>;
    getDraft: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    service = { createDraft: vi.fn(), getDraft: vi.fn() };
    controller = new BookingDraftController(
      service as unknown as BookingDraftService,
    );
  });

  it('delegates the immutable request and language and returns its safe response', async () => {
    const dto = draftInput();
    const response = {
      id: dto.bookingKey,
      userId: OWNER_ID,
      status: 'PENDING',
      legs: [],
    };
    service.createDraft.mockResolvedValue(response);
    expect(await controller.createDraft(dto, 'en')).toBe(response);
    expect(service.createDraft).toHaveBeenCalledWith(dto, 'en');
  });

  it('translates insufficient seats into HTTP 409 with availableCount', async () => {
    service.createDraft.mockRejectedValue(
      new BookingDraftError(ErrorCode.INSUFFICIENT_SEATS, undefined, 2),
    );
    const error = await controller
      .createDraft(draftInput())
      .catch((error: HttpException) => error);
    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).getStatus()).toBe(HttpStatus.CONFLICT);
    expect((error as HttpException).getResponse()).toMatchObject({
      code: ErrorCode.INSUFFICIENT_SEATS,
      availableCount: 2,
      details: [{ field: 'legs', rejectedValue: { availableCount: 2 } }],
    });
  });

  it.each([
    [ErrorCode.VALIDATION_ERROR, 400],
    [ErrorCode.BOOKING_KEY_CONFLICT, 409],
    [ErrorCode.DEPENDENCY_UNAVAILABLE, 503],
    [ErrorCode.INTERNAL_SERVER_ERROR, 500],
  ])(
    'maps %s using the error catalogue, not a default 400',
    async (code, expectedStatus) => {
      service.createDraft.mockRejectedValue(
        new BookingDraftError(code as ErrorCode),
      );
      const error = await controller
        .createDraft(draftInput())
        .catch((error: HttpException) => error);
      expect((error as HttpException).getStatus()).toBe(expectedStatus);
    },
  );

  it('carries only the safe submitted passenger ref and mask in overlap details', async () => {
    service.createDraft.mockRejectedValue(
      new BookingDraftError(
        ErrorCode.PASSENGER_OVERLAP,
        undefined,
        undefined,
        PASSENGER_IDS[0],
        '**********1000',
      ),
    );
    const error = await controller
      .createDraft(draftInput())
      .catch((error: HttpException) => error);
    expect((error as HttpException).getStatus()).toBe(409);
    expect((error as HttpException).getResponse()).toMatchObject({
      code: ErrorCode.PASSENGER_OVERLAP,
      details: [
        {
          field: 'passengerIds',
          rejectedValue: {
            passengerRef: PASSENGER_IDS[0],
            maskedNationalId: '**********1000',
          },
          issueKey: 'ISSUE_PASSENGER_ALREADY_TRAVELLING',
          actionKey: 'ACTION_CHANGE_PASSENGER_OR_TRIP',
        },
      ],
    });
  });

  it('passes the trusted owner to GET', async () => {
    const dto = draftInput();
    const draft = { id: dto.bookingKey, userId: OWNER_ID, status: 'PENDING' };
    service.getDraft.mockResolvedValue(draft);
    expect(await controller.getDraft(dto.bookingKey, OWNER_ID)).toBe(draft);
    expect(service.getDraft).toHaveBeenCalledWith(
      dto.bookingKey,
      OWNER_ID,
      undefined,
    );
  });

  it('returns 404 for absent or foreign drafts', async () => {
    service.getDraft.mockResolvedValue(null);
    await expect(
      controller.getDraft(draftInput().bookingKey, OWNER_ID),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('guards every ingress route and exposes no release/extension HTTP methods', () => {
    expect(
      Reflect.getMetadata(GUARDS_METADATA, BookingDraftController),
    ).toContain(BookingIngressGuard);
    expect(BookingDraftController.prototype).not.toHaveProperty('extendHold');
    expect(BookingDraftController.prototype).not.toHaveProperty('releaseHold');
  });
});

describe('Booking private ingress and DTO', () => {
  afterEach(() => vi.unstubAllEnvs());

  it.each([undefined, '', 'bad-key', ['x'.repeat(40), 'x'.repeat(40)]])(
    'rejects missing, mismatched or repeated credentials before work',
    (actual) => {
      vi.stubEnv('GATEWAY_BOOKING_SERVICE_KEY', 'x'.repeat(40));
      const context = {
        switchToHttp: () => ({
          getRequest: () => ({ headers: { 'x-gateway-booking-key': actual } }),
        }),
      } as unknown as ExecutionContext;
      expect(() => new BookingIngressGuard().canActivate(context)).toThrow(
        UnauthorizedException,
      );
    },
  );

  it('rejects disabled or too-short configuration even if the header matches', () => {
    vi.stubEnv('GATEWAY_BOOKING_SERVICE_KEY', 'short');
    const context = {
      switchToHttp: () => ({
        getRequest: () => ({ headers: { 'x-gateway-booking-key': 'short' } }),
      }),
    } as unknown as ExecutionContext;
    expect(() => new BookingIngressGuard().canActivate(context)).toThrow(
      UnauthorizedException,
    );
  });

  it('accepts the configured key without duplicating Gateway bookable checks', () => {
    vi.stubEnv('GATEWAY_BOOKING_SERVICE_KEY', 'x'.repeat(40));
    const context = {
      switchToHttp: () => ({
        getRequest: () => ({
          headers: { 'x-gateway-booking-key': 'x'.repeat(40) },
        }),
      }),
    } as unknown as ExecutionContext;
    expect(new BookingIngressGuard().canActivate(context)).toBe(true);
  });

  it('validates UUID booking key, trusted owner and nested leg/passenger refs', async () => {
    expect(
      await validate(plainToInstance(CreateBookingDraftDto, draftInput()), {
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    ).toEqual([]);
    const invalid = plainToInstance(CreateBookingDraftDto, {
      ...draftInput(),
      bookingKey: 'not-uuid',
      userId: undefined,
      passengerIds: ['not-uuid'],
      legs: [{ tripId: 'not-uuid' }],
    });
    const errors = await validate(invalid, {
      whitelist: true,
      forbidNonWhitelisted: true,
    });
    expect(errors.map((error) => error.property)).toEqual(
      expect.arrayContaining(['bookingKey', 'userId', 'passengerIds', 'legs']),
    );
  });

  it('rejects raw nationalId, passenger objects and count-only fields at validation', async () => {
    const dto = plainToInstance(CreateBookingDraftDto, {
      ...draftInput(),
      passengerCount: 2,
      groupSize: 2,
      passengers: [
        { passengerId: PASSENGER_IDS[0], nationalId: '29001010112345' },
      ],
    });
    const errors = await validate(dto, {
      whitelist: true,
      forbidNonWhitelisted: true,
    });
    expect(errors.map((error) => error.property)).toEqual(
      expect.arrayContaining(['passengerCount', 'groupSize', 'passengers']),
    );
  });
});
