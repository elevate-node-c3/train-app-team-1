import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as grpc from '@grpc/grpc-js';
import { loadSync } from '@grpc/proto-loader';
import { RpcException } from '@nestjs/microservices';
import type { ClsService } from 'nestjs-cls';
import {
  ErrorCode,
  getIdentityProtoPath,
  type PassengerDto,
} from '@app/contracts';
import { AuthError } from './auth-error.js';
import { AuthGrpcController } from './auth.grpc.controller.js';
import type { AccountsService } from './services/accounts.service.js';
import type { PasswordsService } from './services/passwords.service.js';
import type { ProfileService } from './services/profile.service.js';
import type { SessionsService } from './services/sessions.service.js';
import type { PassengersService } from './services/passengers.service.js';
import type { HoldPassengersService } from './services/hold-passengers.service.js';

describe('AuthGrpcController - Passengers', () => {
  let controller: AuthGrpcController;
  let mockAccounts: Partial<AccountsService>;
  let mockSessions: Partial<SessionsService>;
  let mockPasswords: Partial<PasswordsService>;
  let mockProfiles: Partial<ProfileService>;
  let mockPassengers: Partial<PassengersService>;
  let mockCls: Partial<ClsService>;
  let mockHoldPassengers: Partial<HoldPassengersService>;

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
    mockAccounts = { resolveNotificationRecipient: vi.fn() };
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
    mockHoldPassengers = { resolve: vi.fn() };

    controller = new AuthGrpcController(
      mockAccounts as AccountsService,
      mockSessions as SessionsService,
      mockPasswords as PasswordsService,
      mockProfiles as ProfileService,
      mockPassengers as PassengersService,
      mockCls as ClsService,
      mockHoldPassengers as HoldPassengersService,
    );
  });

  afterEach(() => vi.unstubAllEnvs());

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
      language: 'ar' as const,
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
      language: 'en' as const,
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
    it('masks a non-AuthError instead of describing it', async () => {
      const rawError = new Error('Database connection failed');
      vi.mocked(mockPassengers.listPassengers!).mockRejectedValue(rawError);

      const error = await controller
        .listPassengers({ accountId: 'acc-123' })
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(RpcException);
      const payload = (error as RpcException).getError() as { code: number };
      expect(payload.code).toBe(grpc.status.INTERNAL);
      expect(JSON.stringify(payload)).not.toContain('Database connection');
    });
  });

  describe('private ResolveNotificationRecipient RPC', () => {
    const serviceKey = 'notification-identity-test-only-private-key';
    const request = { accountId: '11111111-1111-4111-8111-111111111111' };

    it('round-trips the private wire contract with only an account id and email', () => {
      const definition = loadSync(getIdentityProtoPath(), { defaults: true })[
        'train.identity.v1.IdentityService'
      ] as grpc.ServiceDefinition;
      const method = definition.ResolveNotificationRecipient;
      expect(method.path).toBe(
        '/train.identity.v1.IdentityService/ResolveNotificationRecipient',
      );
      expect(
        method.requestDeserialize(method.requestSerialize(request)),
      ).toEqual(request);
      const response = { email: 'traveller@example.com' };
      expect(
        method.responseDeserialize(
          method.responseSerialize({
            ...response,
            passwordHash: 'must-not-leave-identity',
            nationalId: '28505150101235',
          }),
        ),
      ).toEqual(response);
      expect(
        method.responseDeserialize(method.responseSerialize({ email: '' })),
      ).toEqual({ email: '' });
    });

    it.each([
      'missing-metadata',
      'missing-key',
      'wrong-key',
      'duplicate-key',
      'unconfigured',
      'short-configuration',
    ])('fails closed before looking up a recipient (%s)', async (mode) => {
      vi.stubEnv(
        'NOTIFICATION_IDENTITY_SERVICE_KEY',
        mode === 'unconfigured'
          ? undefined
          : mode === 'short-configuration'
            ? 'short'
            : serviceKey,
      );
      const metadata = new grpc.Metadata();
      if (mode !== 'missing-key')
        metadata.set(
          'x-notification-identity-key',
          mode === 'wrong-key'
            ? 'wrong'
            : mode === 'short-configuration'
              ? 'short'
              : serviceKey,
        );
      if (mode === 'duplicate-key')
        metadata.add('x-notification-identity-key', serviceKey);
      await expect(
        controller.resolveNotificationRecipient(
          request,
          mode === 'missing-metadata' ? undefined : metadata,
        ),
      ).rejects.toSatisfy((error: unknown) => {
        expect(error).toBeInstanceOf(RpcException);
        expect((error as RpcException).getError()).toMatchObject({
          code: grpc.status.UNAUTHENTICATED,
        });
        return true;
      });
      expect(mockAccounts.resolveNotificationRecipient).not.toHaveBeenCalled();
    });

    it.each(['traveller@example.com', ''])(
      'returns only the authoritative recipient (%j)',
      async (email) => {
        vi.stubEnv('NOTIFICATION_IDENTITY_SERVICE_KEY', serviceKey);
        const metadata = new grpc.Metadata();
        metadata.set('x-notification-identity-key', serviceKey);
        vi.mocked(mockAccounts.resolveNotificationRecipient!).mockResolvedValue(
          { email },
        );
        await expect(
          controller.resolveNotificationRecipient(request, metadata),
        ).resolves.toEqual({ email });
        expect(mockAccounts.resolveNotificationRecipient).toHaveBeenCalledWith(
          request.accountId,
        );
      },
    );

    it('sanitizes unexpected directory failures', async () => {
      vi.stubEnv('NOTIFICATION_IDENTITY_SERVICE_KEY', serviceKey);
      const metadata = new grpc.Metadata();
      metadata.set('x-notification-identity-key', serviceKey);
      vi.mocked(mockAccounts.resolveNotificationRecipient!).mockRejectedValue(
        new Error(`private ${serviceKey} traveller@example.com`),
      );
      await expect(
        controller.resolveNotificationRecipient(request, metadata),
      ).rejects.toSatisfy((error: unknown) => {
        expect((error as RpcException).getError()).toEqual({
          code: grpc.status.UNAVAILABLE,
          details: JSON.stringify({ code: ErrorCode.SERVICE_UNAVAILABLE }),
          message: ErrorCode.SERVICE_UNAVAILABLE,
        });
        return true;
      });
    });
  });

  describe('private ResolveHoldPassengers RPC', () => {
    const serviceKey = 'booking-identity-test-only-private-key';
    const request = {
      ownerId: '11111111-1111-4111-8111-111111111111',
      passengerRefs: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'],
      tripIds: ['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'],
    };

    it('registers the exact private RPC wire contract without a raw National ID field', () => {
      const definition = loadSync(getIdentityProtoPath(), { defaults: true })[
        'train.identity.v1.IdentityService'
      ] as grpc.ServiceDefinition;
      const method = definition.ResolveHoldPassengers;
      expect(method.path).toBe(
        '/train.identity.v1.IdentityService/ResolveHoldPassengers',
      );
      expect(
        method.requestDeserialize(method.requestSerialize(request)),
      ).toEqual(request);
      const response = {
        passengers: [
          {
            passengerRef: request.passengerRefs[0],
            displayName: 'Ahmed Hussein',
            maskedNationalId: '**********1235',
            identities: [
              {
                tripId: request.tripIds[0],
                passengerToken: 'a'.repeat(64),
                passengerKeyVersion: 1,
              },
            ],
          },
        ],
      };
      const encoded = method.responseSerialize({
        passengers: [
          { ...response.passengers[0], nationalId: '28505150101235' },
        ],
      });
      expect(method.responseDeserialize(encoded)).toEqual(response);
      expect(encoded.toString()).not.toContain('28505150101235');
    });

    it.each([
      'missing-metadata',
      'missing-key',
      'wrong-key',
      'duplicate-key',
      'unconfigured',
      'short-configuration',
    ])('authenticates before resolver/repository work (%s)', async (mode) => {
      vi.stubEnv(
        'BOOKING_IDENTITY_SERVICE_KEY',
        mode === 'unconfigured'
          ? undefined
          : mode === 'short-configuration'
            ? 'short'
            : serviceKey,
      );
      const metadata = new grpc.Metadata();
      if (mode !== 'missing-key')
        metadata.set(
          'x-booking-identity-key',
          mode === 'wrong-key'
            ? 'wrong'
            : mode === 'short-configuration'
              ? 'short'
              : serviceKey,
        );
      if (mode === 'duplicate-key')
        metadata.add('x-booking-identity-key', serviceKey);
      await expect(
        controller.resolveHoldPassengers(
          request,
          mode === 'missing-metadata' ? undefined : metadata,
        ),
      ).rejects.toSatisfy((error: unknown) => {
        expect(error).toBeInstanceOf(RpcException);
        expect((error as RpcException).getError()).toEqual({
          code: grpc.status.UNAUTHENTICATED,
          details: JSON.stringify({ code: ErrorCode.UNAUTHORIZED }),
          message: ErrorCode.UNAUTHORIZED,
        });
        return true;
      });
      expect(mockHoldPassengers.resolve).not.toHaveBeenCalled();
      expect(mockPassengers.listPassengers).not.toHaveBeenCalled();
    });

    it('delegates the authenticated request without adding BR-10 admission checks', async () => {
      vi.stubEnv('BOOKING_IDENTITY_SERVICE_KEY', serviceKey);
      const metadata = new grpc.Metadata();
      metadata.set('x-booking-identity-key', serviceKey);
      const response = {
        passengers: [
          {
            passengerRef: request.passengerRefs[0],
            displayName: 'Ahmed Hussein',
            maskedNationalId: '**********1235',
            identities: [
              {
                tripId: request.tripIds[0],
                passengerToken: 'a'.repeat(64),
                passengerKeyVersion: 1,
              },
            ],
          },
        ],
      };
      vi.mocked(mockHoldPassengers.resolve!).mockResolvedValue(response);
      await expect(
        controller.resolveHoldPassengers(request, metadata),
      ).resolves.toEqual(response);
      expect(mockHoldPassengers.resolve).toHaveBeenCalledWith(request);
      expect(mockCls.get).not.toHaveBeenCalled();
    });

    it.each([
      [ErrorCode.PASSENGER_NOT_FOUND, grpc.status.NOT_FOUND],
      [ErrorCode.BAD_REQUEST, grpc.status.INVALID_ARGUMENT],
      [ErrorCode.SERVICE_UNAVAILABLE, grpc.status.UNAVAILABLE],
    ] as const)(
      'preserves only the safe failure code (%s)',
      async (code, status) => {
        vi.stubEnv('BOOKING_IDENTITY_SERVICE_KEY', serviceKey);
        const metadata = new grpc.Metadata();
        metadata.set('x-booking-identity-key', serviceKey);
        vi.mocked(mockHoldPassengers.resolve!).mockRejectedValue(
          new AuthError(code, `private ${serviceKey} 28505150101235`),
        );
        await expect(
          controller.resolveHoldPassengers(request, metadata),
        ).rejects.toSatisfy((error: unknown) => {
          expect((error as RpcException).getError()).toEqual({
            code: status,
            details: JSON.stringify({ code }),
            message: code,
          });
          return true;
        });
      },
    );

    it('sanitizes unexpected private-RPC failures while preserving older RPC behavior', async () => {
      vi.stubEnv('BOOKING_IDENTITY_SERVICE_KEY', serviceKey);
      const metadata = new grpc.Metadata();
      metadata.set('x-booking-identity-key', serviceKey);
      vi.mocked(mockHoldPassengers.resolve!).mockRejectedValue(
        new Error(`database parameters ${serviceKey} 28505150101235`),
      );
      await expect(
        controller.resolveHoldPassengers(request, metadata),
      ).rejects.toSatisfy((error: unknown) => {
        expect((error as RpcException).getError()).toEqual({
          code: grpc.status.UNAVAILABLE,
          details: JSON.stringify({ code: ErrorCode.SERVICE_UNAVAILABLE }),
          message: ErrorCode.SERVICE_UNAVAILABLE,
        });
        return true;
      });
    });
  });
});
