import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as grpc from '@grpc/grpc-js';
import { RpcException } from '@nestjs/microservices';
import type { ClsService } from 'nestjs-cls';
import { ErrorCode, type PassengerDto } from '@app/contracts';
import { AuthError } from './auth-error.js';
import { AuthGrpcController } from './auth.grpc.controller.js';
import type { AccountsService } from './services/accounts.service.js';
import type { PasswordsService } from './services/passwords.service.js';
import type { ProfileService } from './services/profile.service.js';
import type { SessionsService } from './services/sessions.service.js';
import type { PassengersService } from './services/passengers.service.js';

describe('AuthGrpcController - Passengers', () => {
  let controller: AuthGrpcController;
  let mockAccounts: Partial<AccountsService>;
  let mockSessions: Partial<SessionsService>;
  let mockPasswords: Partial<PasswordsService>;
  let mockProfiles: Partial<ProfileService>;
  let mockPassengers: Partial<PassengersService>;
  let mockCls: Partial<ClsService>;

  const mockPassengerDto: PassengerDto = {
    id: 'pass-123',
    fullName: 'Ahmed Hussein',
    nationalId: '28505150101235',
    profileType: 'Regular',
    typeName: 'كوامل',
    isSelf: false,
    createdAt: '2026-11-06T20:00:00.000Z',
  };

  beforeEach(() => {
    mockAccounts = {};
    mockSessions = {};
    mockPasswords = {};
    mockProfiles = {};
    mockPassengers = {
      listPassengers: vi.fn(),
      addPassenger: vi.fn(),
      updatePassenger: vi.fn(),
      deletePassenger: vi.fn(),
    };
    mockCls = {
      get: vi.fn(),
    };

    controller = new AuthGrpcController(
      mockAccounts as AccountsService,
      mockSessions as SessionsService,
      mockPasswords as PasswordsService,
      mockProfiles as ProfileService,
      mockPassengers as PassengersService,
      mockCls as ClsService,
    );
  });

  describe('listPassengers', () => {
    it('delegates to PassengersService.listPassengers and returns { passengers }', async () => {
      const expectedPassengers: PassengerDto[] = [mockPassengerDto];
      vi.mocked(mockPassengers.listPassengers!).mockResolvedValue(
        expectedPassengers,
      );

      const result = await controller.listPassengers({
        accountId: 'acc-123',
        language: 'ar',
      });

      expect(mockPassengers.listPassengers).toHaveBeenCalledWith(
        'acc-123',
        'ar',
      );
      expect(result).toEqual({ passengers: expectedPassengers });
    });

    it('translates UNAUTHORIZED AuthError into RpcException with UNAUTHENTICATED', async () => {
      vi.mocked(mockPassengers.listPassengers!).mockRejectedValue(
        new AuthError(ErrorCode.UNAUTHORIZED),
      );

      await expect(
        controller.listPassengers({ accountId: '', language: 'ar' }),
      ).rejects.toSatisfy((err: unknown) => {
        expect(err).toBeInstanceOf(RpcException);
        const rpcErr = (err as RpcException).getError() as {
          code: number;
          details: string;
          message: string;
        };
        expect(rpcErr.code).toBe(grpc.status.UNAUTHENTICATED);
        expect(JSON.parse(rpcErr.details)).toEqual({
          code: ErrorCode.UNAUTHORIZED,
        });
        return true;
      });
    });
  });

  describe('addPassenger', () => {
    const addRequest = {
      accountId: 'acc-123',
      fullName: 'Ahmed Hussein',
      nationalId: '28505150101235',
      profileType: 'Regular',
      language: 'ar',
    };

    it('delegates to PassengersService.addPassenger and returns { passenger }', async () => {
      vi.mocked(mockPassengers.addPassenger!).mockResolvedValue(
        mockPassengerDto,
      );

      const result = await controller.addPassenger(addRequest);

      expect(mockPassengers.addPassenger).toHaveBeenCalledWith(addRequest);
      expect(result).toEqual({ passenger: mockPassengerDto });
    });

    it('translates PASSENGER_LIMIT_REACHED into FAILED_PRECONDITION', async () => {
      vi.mocked(mockPassengers.addPassenger!).mockRejectedValue(
        new AuthError(ErrorCode.PASSENGER_LIMIT_REACHED),
      );

      await expect(controller.addPassenger(addRequest)).rejects.toSatisfy(
        (err: unknown) => {
          expect(err).toBeInstanceOf(RpcException);
          const rpcErr = (err as RpcException).getError() as {
            code: number;
            details: string;
          };
          expect(rpcErr.code).toBe(grpc.status.FAILED_PRECONDITION);
          expect(JSON.parse(rpcErr.details)).toEqual({
            code: ErrorCode.PASSENGER_LIMIT_REACHED,
          });
          return true;
        },
      );
    });

    it('translates NATIONAL_ID_ALREADY_REGISTERED into ALREADY_EXISTS', async () => {
      vi.mocked(mockPassengers.addPassenger!).mockRejectedValue(
        new AuthError(ErrorCode.NATIONAL_ID_ALREADY_REGISTERED),
      );

      await expect(controller.addPassenger(addRequest)).rejects.toSatisfy(
        (err: unknown) => {
          expect(err).toBeInstanceOf(RpcException);
          const rpcErr = (err as RpcException).getError() as {
            code: number;
            details: string;
          };
          expect(rpcErr.code).toBe(grpc.status.ALREADY_EXISTS);
          expect(JSON.parse(rpcErr.details)).toEqual({
            code: ErrorCode.NATIONAL_ID_ALREADY_REGISTERED,
          });
          return true;
        },
      );
    });

    it('translates INVALID_FULL_NAME into INVALID_ARGUMENT', async () => {
      vi.mocked(mockPassengers.addPassenger!).mockRejectedValue(
        new AuthError(ErrorCode.INVALID_FULL_NAME),
      );

      await expect(controller.addPassenger(addRequest)).rejects.toSatisfy(
        (err: unknown) => {
          expect(err).toBeInstanceOf(RpcException);
          const rpcErr = (err as RpcException).getError() as {
            code: number;
            details: string;
          };
          expect(rpcErr.code).toBe(grpc.status.INVALID_ARGUMENT);
          expect(JSON.parse(rpcErr.details)).toEqual({
            code: ErrorCode.INVALID_FULL_NAME,
          });
          return true;
        },
      );
    });
  });

  describe('updatePassenger', () => {
    const updateRequest = {
      passengerId: 'pass-123',
      accountId: 'acc-123',
      fullName: 'Ahmed Hussein Ali',
      nationalId: '28505150101235',
      profileType: 'Regular',
      language: 'en',
    };

    it('delegates to PassengersService.updatePassenger and returns { passenger }', async () => {
      const updatedPassenger: PassengerDto = {
        ...mockPassengerDto,
        fullName: 'Ahmed Hussein Ali',
        typeName: 'Regular',
      };
      vi.mocked(mockPassengers.updatePassenger!).mockResolvedValue(
        updatedPassenger,
      );

      const result = await controller.updatePassenger(updateRequest);

      expect(mockPassengers.updatePassenger).toHaveBeenCalledWith(
        updateRequest,
      );
      expect(result).toEqual({ passenger: updatedPassenger });
    });

    it('translates PASSENGER_NOT_FOUND into NOT_FOUND', async () => {
      vi.mocked(mockPassengers.updatePassenger!).mockRejectedValue(
        new AuthError(ErrorCode.PASSENGER_NOT_FOUND),
      );

      await expect(controller.updatePassenger(updateRequest)).rejects.toSatisfy(
        (err: unknown) => {
          expect(err).toBeInstanceOf(RpcException);
          const rpcErr = (err as RpcException).getError() as {
            code: number;
            details: string;
          };
          expect(rpcErr.code).toBe(grpc.status.NOT_FOUND);
          expect(JSON.parse(rpcErr.details)).toEqual({
            code: ErrorCode.PASSENGER_NOT_FOUND,
          });
          return true;
        },
      );
    });

    it('translates NATIONAL_ID_LOCKED into FAILED_PRECONDITION', async () => {
      vi.mocked(mockPassengers.updatePassenger!).mockRejectedValue(
        new AuthError(ErrorCode.NATIONAL_ID_LOCKED),
      );

      await expect(controller.updatePassenger(updateRequest)).rejects.toSatisfy(
        (err: unknown) => {
          expect(err).toBeInstanceOf(RpcException);
          const rpcErr = (err as RpcException).getError() as {
            code: number;
            details: string;
          };
          expect(rpcErr.code).toBe(grpc.status.FAILED_PRECONDITION);
          expect(JSON.parse(rpcErr.details)).toEqual({
            code: ErrorCode.NATIONAL_ID_LOCKED,
          });
          return true;
        },
      );
    });
  });

  describe('deletePassenger', () => {
    const deleteRequest = {
      passengerId: 'pass-123',
      accountId: 'acc-123',
    };

    it('delegates to PassengersService.deletePassenger and returns { success: true }', async () => {
      vi.mocked(mockPassengers.deletePassenger!).mockResolvedValue(undefined);

      const result = await controller.deletePassenger(deleteRequest);

      expect(mockPassengers.deletePassenger).toHaveBeenCalledWith(
        deleteRequest,
      );
      expect(result).toEqual({ success: true });
    });

    it('translates CANNOT_DELETE_SELF_PASSENGER into FAILED_PRECONDITION', async () => {
      vi.mocked(mockPassengers.deletePassenger!).mockRejectedValue(
        new AuthError(ErrorCode.CANNOT_DELETE_SELF_PASSENGER),
      );

      await expect(controller.deletePassenger(deleteRequest)).rejects.toSatisfy(
        (err: unknown) => {
          expect(err).toBeInstanceOf(RpcException);
          const rpcErr = (err as RpcException).getError() as {
            code: number;
            details: string;
          };
          expect(rpcErr.code).toBe(grpc.status.FAILED_PRECONDITION);
          expect(JSON.parse(rpcErr.details)).toEqual({
            code: ErrorCode.CANNOT_DELETE_SELF_PASSENGER,
          });
          return true;
        },
      );
    });

    it('translates PASSENGER_NOT_FOUND into NOT_FOUND', async () => {
      vi.mocked(mockPassengers.deletePassenger!).mockRejectedValue(
        new AuthError(ErrorCode.PASSENGER_NOT_FOUND),
      );

      await expect(controller.deletePassenger(deleteRequest)).rejects.toSatisfy(
        (err: unknown) => {
          expect(err).toBeInstanceOf(RpcException);
          const rpcErr = (err as RpcException).getError() as {
            code: number;
            details: string;
          };
          expect(rpcErr.code).toBe(grpc.status.NOT_FOUND);
          expect(JSON.parse(rpcErr.details)).toEqual({
            code: ErrorCode.PASSENGER_NOT_FOUND,
          });
          return true;
        },
      );
    });
  });

  describe('unexpected errors', () => {
    it('rethrows non-AuthError unhandled error directly', async () => {
      const rawError = new Error('Database connection failed');
      vi.mocked(mockPassengers.listPassengers!).mockRejectedValue(rawError);

      await expect(
        controller.listPassengers({ accountId: 'acc-123' }),
      ).rejects.toThrow(rawError);
    });
  });
});
