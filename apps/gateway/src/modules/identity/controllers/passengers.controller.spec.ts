import { describe, expect, it, vi } from 'vitest';
import { HttpException, HttpStatus } from '@nestjs/common';
import type { ClsService } from 'nestjs-cls';
import {
  ACCESS_LEVEL_KEY,
  CALLER_ACCOUNT_ID_KEY,
  RATE_LIMIT_KEY,
  type RateLimitOptions,
} from '@app/common';
import {
  ErrorCode,
  type ListPassengersResponseDto,
  type PassengerDto,
} from '@app/contracts';
import { PassengersController } from './passengers.controller.js';
import type { IdentityService } from '../identity.service.js';
import type {
  CreatePassengerDto,
  UpdatePassengerDto,
} from '../dto/passenger.dto.js';

const SAMPLE_PASSENGER: PassengerDto = {
  id: 'pass-1',
  fullName: 'Sara Ahmed',
  nationalId: '29001011234567',
  profileType: 'Regular',
  typeName: 'Regular',
  isSelf: false,
  createdAt: '2026-11-06T20:00:00.000Z',
};

const LIST_RESPONSE: ListPassengersResponseDto = {
  passengers: [SAMPLE_PASSENGER],
};

function harness(accountId: string | null = 'acc-1'): {
  controller: PassengersController;
  identity: {
    listPassengers: ReturnType<typeof vi.fn>;
    addPassenger: ReturnType<typeof vi.fn>;
    updatePassenger: ReturnType<typeof vi.fn>;
    deletePassenger: ReturnType<typeof vi.fn>;
  };
  cls: {
    get: ReturnType<typeof vi.fn>;
  };
} {
  const identity = {
    listPassengers: vi.fn(async () => LIST_RESPONSE),
    addPassenger: vi.fn(async () => SAMPLE_PASSENGER),
    updatePassenger: vi.fn(async () => SAMPLE_PASSENGER),
    deletePassenger: vi.fn(async () => undefined),
  };
  const cls = {
    get: vi.fn((key: string) => {
      if (key === CALLER_ACCOUNT_ID_KEY) return accountId ?? undefined;
      return undefined;
    }),
  };
  return {
    controller: new PassengersController(
      identity as unknown as IdentityService,
      cls as unknown as ClsService,
    ),
    identity,
    cls,
  };
}

describe('PassengersController', () => {
  describe('GET / (list)', () => {
    it('forwards list request to identity service with caller accountId and default language', async () => {
      const { controller, identity } = harness('acc-1');

      const result = await controller.list();

      expect(identity.listPassengers).toHaveBeenCalledWith('acc-1', 'ar');
      expect(result).toEqual(LIST_RESPONSE);
    });

    it('resolves English language header when accept-language starts with en', async () => {
      const { controller, identity } = harness('acc-1');

      await controller.list('en-US,en;q=0.9');

      expect(identity.listPassengers).toHaveBeenCalledWith('acc-1', 'en');
    });

    it('resolves Arabic language header when accept-language is Arabic, other, or empty', async () => {
      const { controller, identity } = harness('acc-1');

      await controller.list('ar-EG');
      expect(identity.listPassengers).toHaveBeenLastCalledWith('acc-1', 'ar');

      await controller.list('fr-FR');
      expect(identity.listPassengers).toHaveBeenLastCalledWith('acc-1', 'ar');

      await controller.list('');
      expect(identity.listPassengers).toHaveBeenLastCalledWith('acc-1', 'ar');
    });

    it('throws 401 Unauthorized when accountId is missing from CLS', async () => {
      const { controller } = harness(null);

      await expect(controller.list()).rejects.toSatisfy(
        (err: unknown) =>
          err instanceof HttpException &&
          err.getStatus() === HttpStatus.UNAUTHORIZED &&
          (err.getResponse() as { code: string }).code ===
            ErrorCode.UNAUTHORIZED,
      );
    });
  });

  describe('POST / (add)', () => {
    const createBody: CreatePassengerDto = {
      fullName: 'Sara Ahmed',
      nationalId: '29001011234567',
      profileType: 'Regular',
    };

    it('adds passenger and returns wrapped passenger with 201 status', async () => {
      const { controller, identity } = harness('acc-1');

      const result = await controller.add(createBody, 'en');

      expect(identity.addPassenger).toHaveBeenCalledWith({
        accountId: 'acc-1',
        fullName: 'Sara Ahmed',
        nationalId: '29001011234567',
        profileType: 'Regular',
        language: 'en',
      });
      expect(result).toEqual({ passenger: SAMPLE_PASSENGER });
    });

    it('defaults language to ar if accept-language is omitted', async () => {
      const { controller, identity } = harness('acc-1');

      await controller.add(createBody);

      expect(identity.addPassenger).toHaveBeenCalledWith({
        accountId: 'acc-1',
        fullName: 'Sara Ahmed',
        nationalId: '29001011234567',
        profileType: 'Regular',
        language: 'ar',
      });
    });

    it('throws 401 Unauthorized when accountId is missing from CLS', async () => {
      const { controller } = harness(null);

      await expect(controller.add(createBody)).rejects.toSatisfy(
        (err: unknown) =>
          err instanceof HttpException &&
          err.getStatus() === HttpStatus.UNAUTHORIZED &&
          (err.getResponse() as { code: string }).code ===
            ErrorCode.UNAUTHORIZED,
      );
    });
  });

  describe('PUT /:id (update)', () => {
    const updateBody: UpdatePassengerDto = {
      fullName: 'Sara Ahmed Updated',
      nationalId: '29001011234567',
      profileType: 'Regular',
    };

    it('updates passenger and returns wrapped passenger with 200 status', async () => {
      const { controller, identity } = harness('acc-1');

      const result = await controller.update('pass-1', updateBody, 'en-GB');

      expect(identity.updatePassenger).toHaveBeenCalledWith({
        passengerId: 'pass-1',
        accountId: 'acc-1',
        fullName: 'Sara Ahmed Updated',
        nationalId: '29001011234567',
        profileType: 'Regular',
        language: 'en',
      });
      expect(result).toEqual({ passenger: SAMPLE_PASSENGER });
    });

    it('throws 401 Unauthorized when accountId is missing from CLS', async () => {
      const { controller } = harness(null);

      await expect(controller.update('pass-1', updateBody)).rejects.toSatisfy(
        (err: unknown) =>
          err instanceof HttpException &&
          err.getStatus() === HttpStatus.UNAUTHORIZED &&
          (err.getResponse() as { code: string }).code ===
            ErrorCode.UNAUTHORIZED,
      );
    });
  });

  describe('DELETE /:id (delete)', () => {
    it('deletes passenger and returns void with 204 status', async () => {
      const { controller, identity } = harness('acc-1');

      const result = await controller.delete('pass-1');

      expect(identity.deletePassenger).toHaveBeenCalledWith('pass-1', 'acc-1');
      expect(result).toBeUndefined();
    });

    it('throws 401 Unauthorized when accountId is missing from CLS', async () => {
      const { controller } = harness(null);

      await expect(controller.delete('pass-1')).rejects.toSatisfy(
        (err: unknown) =>
          err instanceof HttpException &&
          err.getStatus() === HttpStatus.UNAUTHORIZED &&
          (err.getResponse() as { code: string }).code ===
            ErrorCode.UNAUTHORIZED,
      );
    });
  });

  describe('Route metadata', () => {
    it('declares traveller access level on all routes and class', () => {
      expect(Reflect.getMetadata(ACCESS_LEVEL_KEY, PassengersController)).toBe(
        'traveller',
      );
      expect(
        Reflect.getMetadata(
          ACCESS_LEVEL_KEY,
          PassengersController.prototype.list,
        ),
      ).toBe('traveller');
      expect(
        Reflect.getMetadata(
          ACCESS_LEVEL_KEY,
          PassengersController.prototype.add,
        ),
      ).toBe('traveller');
      expect(
        Reflect.getMetadata(
          ACCESS_LEVEL_KEY,
          PassengersController.prototype.update,
        ),
      ).toBe('traveller');
      expect(
        Reflect.getMetadata(
          ACCESS_LEVEL_KEY,
          PassengersController.prototype.delete,
        ),
      ).toBe('traveller');
    });

    it('pins rate-limit buckets to all passenger routes', () => {
      const expected: Record<string, RateLimitOptions> = {
        list: { bucket: 'list-passengers', limit: 30, windowSeconds: 60 },
        add: { bucket: 'add-passenger', limit: 10, windowSeconds: 60 },
        update: { bucket: 'update-passenger', limit: 10, windowSeconds: 60 },
        delete: { bucket: 'delete-passenger', limit: 10, windowSeconds: 60 },
      };

      for (const [route, options] of Object.entries(expected)) {
        expect(
          Reflect.getMetadata(
            RATE_LIMIT_KEY,
            PassengersController.prototype[
              route as keyof PassengersController
            ] as Function,
          ),
        ).toEqual(options);
      }
    });

    it('assigns correct HTTP status codes to all handlers', () => {
      expect(
        Reflect.getMetadata(
          '__httpCode__',
          PassengersController.prototype.list,
        ),
      ).toBe(HttpStatus.OK);
      expect(
        Reflect.getMetadata('__httpCode__', PassengersController.prototype.add),
      ).toBe(HttpStatus.CREATED);
      expect(
        Reflect.getMetadata(
          '__httpCode__',
          PassengersController.prototype.update,
        ),
      ).toBe(HttpStatus.OK);
      expect(
        Reflect.getMetadata(
          '__httpCode__',
          PassengersController.prototype.delete,
        ),
      ).toBe(HttpStatus.NO_CONTENT);
    });
  });
});
