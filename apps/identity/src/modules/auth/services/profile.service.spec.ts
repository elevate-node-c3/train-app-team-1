import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorCode } from '@app/contracts';
import type { TransactionContext } from '@app/common/persistence/unit-of-work.port.js';
import { AccountEntity } from '../entities/account.entity.js';
import { PassengerEntity } from '../entities/passenger.entity.js';
import { ProfileTypeEntity } from '../entities/profile-type.entity.js';
import { NationalityEntity } from '../entities/nationality.entity.js';
import {
  ProfileService,
  type CompleteProfileCommand,
} from './profile.service.js';

describe('ProfileService', () => {
  let service: ProfileService;
  let mockUnitOfWork: any;
  let mockOutbox: any;
  let mockAccounts: any;
  let mockPassengers: any;
  let mockProfileTypes: any;
  let mockNationalities: any;
  let mockSessions: any;

  const validCommand: CompleteProfileCommand = {
    accountId: 'acc-123',
    correlationId: 'corr-123',
    fullName: 'Ahmed Hussein',
    phoneNumber: '01001234567',
    nationalId: '28505150101235', // 1985-05-15, Cairo (01)
    profileType: 'Regular',
    nationality: 'Egyptian',
  };

  beforeEach(() => {
    mockUnitOfWork = {
      withTransaction: vi.fn(
        async (work: (ctx: TransactionContext) => Promise<any>) =>
          work({ driver: 'mock' } as TransactionContext),
      ),
    };
    mockOutbox = {
      append: vi.fn().mockResolvedValue(undefined),
    };
    mockAccounts = {
      findById: vi.fn(),
      findByIdForUpdate: vi.fn(),
      update: vi.fn().mockResolvedValue(undefined),
    };
    mockPassengers = {
      findByAccountAndNationalId: vi.fn().mockResolvedValue(null),
      save: vi.fn().mockResolvedValue(undefined),
      update: vi.fn().mockResolvedValue(undefined),
    };
    mockProfileTypes = {
      findByCode: vi.fn().mockImplementation(async (code: string) => {
        if (code === 'Regular') {
          const pt = new ProfileTypeEntity();
          pt.code = 'Regular';
          pt.nameAr = 'عادي';
          pt.nameEn = 'Regular';
          return pt;
        }
        return null;
      }),
      findAll: vi
        .fn()
        .mockResolvedValue([
          { code: 'Regular', nameAr: 'عادي', nameEn: 'Regular' },
        ]),
    };
    mockNationalities = {
      findByCode: vi.fn().mockImplementation(async (code: string) => {
        if (code === 'Egyptian') {
          const nat = new NationalityEntity();
          nat.code = 'Egyptian';
          nat.nameAr = 'مصري';
          nat.nameEn = 'Egyptian';
          return nat;
        }
        return null;
      }),
      findAll: vi
        .fn()
        .mockResolvedValue([
          { code: 'Egyptian', nameAr: 'مصري', nameEn: 'Egyptian' },
        ]),
    };
    mockSessions = {
      issue: vi.fn().mockResolvedValue({
        tokens: {
          accessToken: 'new-token-with-bkbl-true',
          refreshToken: 'new-refresh-token',
          tokenType: 'Bearer',
          accessExpiresIn: 900,
          refreshExpiresIn: 2592000,
        },
      }),
    };

    service = new ProfileService(
      mockUnitOfWork,
      mockOutbox,
      mockAccounts,
      mockPassengers,
      mockProfileTypes,
      mockNationalities,
      mockSessions,
    );
  });

  describe('completeProfile', () => {
    it('rejects without accountId with UNAUTHORIZED', async () => {
      await expect(
        service.completeProfile({ ...validCommand, accountId: '' }),
      ).rejects.toMatchObject({ code: ErrorCode.UNAUTHORIZED });
    });

    it('rejects invalid full name naming the field', async () => {
      const error = await service
        .completeProfile({ ...validCommand, fullName: 'SingleName' })
        .catch((err) => err);
      expect(error.code).toBe(ErrorCode.VALIDATION_ERROR);
      expect(error.details.some((d: any) => d.field === 'fullName')).toBe(true);
    });

    it('rejects invalid phone format naming the field', async () => {
      const error = await service
        .completeProfile({ ...validCommand, phoneNumber: '12345' })
        .catch((err) => err);
      expect(error.code).toBe(ErrorCode.VALIDATION_ERROR);
      expect(error.details.some((d: any) => d.field === 'phoneNumber')).toBe(
        true,
      );
    });

    it('rejects invalid NID naming the field and length issue', async () => {
      const error = await service
        .completeProfile({ ...validCommand, nationalId: '26582264865' })
        .catch((err) => err);
      expect(error.code).toBe(ErrorCode.VALIDATION_ERROR);
      expect(
        error.details.some(
          (d: any) =>
            d.field === 'nationalId' &&
            d.issueKey === 'ISSUE_NATIONAL_ID_LENGTH',
        ),
      ).toBe(true);
    });

    it('rejects invalid profile type naming the field', async () => {
      const error = await service
        .completeProfile({ ...validCommand, profileType: 'VIP' })
        .catch((err) => err);
      expect(error.code).toBe(ErrorCode.VALIDATION_ERROR);
      expect(error.details.some((d: any) => d.field === 'profileType')).toBe(
        true,
      );
    });

    it('rejects invalid nationality naming the field', async () => {
      const error = await service
        .completeProfile({ ...validCommand, nationality: 'French' })
        .catch((err) => err);
      expect(error.code).toBe(ErrorCode.VALIDATION_ERROR);
      expect(error.details.some((d: any) => d.field === 'nationality')).toBe(
        true,
      );
    });

    it('collects all failures across name, phone, NID and lookups in a single refusal (BR-57)', async () => {
      const error = await service
        .completeProfile({
          ...validCommand,
          fullName: 'Single',
          phoneNumber: 'not-a-phone',
          nationalId: '26582264865',
          profileType: 'VIP',
          nationality: 'French',
        })
        .catch((err) => err);
      expect(error.code).toBe(ErrorCode.VALIDATION_ERROR);
      const fields = error.details.map((d: any) => d.field);
      expect(fields).toContain('fullName');
      expect(fields).toContain('phoneNumber');
      expect(fields).toContain('nationalId');
      expect(fields).toContain('profileType');
      expect(fields).toContain('nationality');
    });

    it('rejects unverified account with EMAIL_NOT_VERIFIED', async () => {
      const account = new AccountEntity();
      account.id = validCommand.accountId;
      account.emailVerifiedAt = null;
      account.bookable = false;
      account.status = 'pending';
      mockAccounts.findByIdForUpdate.mockResolvedValue(account);

      await expect(service.completeProfile(validCommand)).rejects.toMatchObject(
        {
          code: ErrorCode.EMAIL_NOT_VERIFIED,
        },
      );
    });

    it('rejects disabled account with ACCOUNT_DISABLED', async () => {
      const account = new AccountEntity();
      account.id = validCommand.accountId;
      account.emailVerifiedAt = new Date();
      account.bookable = false;
      account.status = 'disabled';
      mockAccounts.findByIdForUpdate.mockResolvedValue(account);

      await expect(service.completeProfile(validCommand)).rejects.toMatchObject(
        {
          code: ErrorCode.ACCOUNT_DISABLED,
        },
      );
    });

    it('rejects already completed profile with PROFILE_ALREADY_COMPLETE', async () => {
      const account = new AccountEntity();
      account.id = validCommand.accountId;
      account.emailVerifiedAt = new Date();
      account.bookable = true;
      account.status = 'active';
      mockAccounts.findByIdForUpdate.mockResolvedValue(account);

      await expect(service.completeProfile(validCommand)).rejects.toMatchObject(
        {
          code: ErrorCode.PROFILE_ALREADY_COMPLETE,
        },
      );
    });

    it('successfully completes profile and creates a new self passenger', async () => {
      const account = new AccountEntity();
      account.id = validCommand.accountId;
      account.emailVerifiedAt = new Date();
      account.bookable = false;
      account.status = 'active';
      mockAccounts.findByIdForUpdate.mockResolvedValue(account);

      const result = await service.completeProfile(validCommand);

      expect(account.bookable).toBe(true);
      expect(account.fullName).toBe('Ahmed Hussein');
      expect(account.phoneNumber).toBe('01001234567');
      expect(account.nationalId).toBe('28505150101235');
      expect(mockAccounts.update).toHaveBeenCalledWith(
        expect.anything(),
        account,
      );
      expect(mockPassengers.save).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          accountId: account.id,
          fullName: 'Ahmed Hussein',
          nationalId: '28505150101235',
          isSelf: true,
        }),
      );
      expect(mockOutbox.append).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          type: 'identity.profile.completed',
          payload: {
            accountId: account.id,
            fullName: 'Ahmed Hussein',
            completedAt: expect.any(String),
          },
        }),
      );
      expect(result.profile.bookable).toBe(true);
      expect(result.tokens.accessToken).toBe('new-token-with-bkbl-true');
    });

    it('adopts existing saved passenger as self if matching NID exists', async () => {
      const account = new AccountEntity();
      account.id = validCommand.accountId;
      account.emailVerifiedAt = new Date();
      account.bookable = false;
      account.status = 'active';
      mockAccounts.findByIdForUpdate.mockResolvedValue(account);

      const existingPassenger = new PassengerEntity();
      existingPassenger.id = 'passenger-999';
      existingPassenger.accountId = account.id;
      existingPassenger.nationalId = '28505150101235';
      existingPassenger.isSelf = false;
      mockPassengers.findByAccountAndNationalId.mockResolvedValue(
        existingPassenger,
      );

      await service.completeProfile(validCommand);

      expect(mockPassengers.save).not.toHaveBeenCalled();
      expect(mockPassengers.update).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          id: 'passenger-999',
          isSelf: true,
          fullName: 'Ahmed Hussein',
        }),
      );
    });

    it('maps unique constraint violation on phone to PHONE_ALREADY_REGISTERED', async () => {
      const account = new AccountEntity();
      account.id = validCommand.accountId;
      account.emailVerifiedAt = new Date();
      account.bookable = false;
      account.status = 'active';
      mockAccounts.findByIdForUpdate.mockResolvedValue(account);

      mockAccounts.update.mockRejectedValue({
        code: '23505',
        constraint: 'uq_account_phone',
      });

      await expect(service.completeProfile(validCommand)).rejects.toMatchObject(
        {
          code: ErrorCode.PHONE_ALREADY_REGISTERED,
        },
      );
    });

    it('maps unique constraint violation on national_id to NATIONAL_ID_ALREADY_REGISTERED', async () => {
      const account = new AccountEntity();
      account.id = validCommand.accountId;
      account.emailVerifiedAt = new Date();
      account.bookable = false;
      account.status = 'active';
      mockAccounts.findByIdForUpdate.mockResolvedValue(account);

      mockPassengers.save.mockRejectedValue({
        code: '23505',
        constraint: 'uq_passenger_self_nid',
      });

      await expect(service.completeProfile(validCommand)).rejects.toMatchObject(
        {
          code: ErrorCode.NATIONAL_ID_ALREADY_REGISTERED,
        },
      );
    });
  });

  describe('getProfile', () => {
    it('returns null fields and bookable=false when profile is incomplete', async () => {
      const account = new AccountEntity();
      account.id = 'acc-123';
      account.bookable = false;
      mockAccounts.findById.mockResolvedValue(account);

      const res = await service.getProfile('acc-123');
      expect(res).toEqual({
        accountId: 'acc-123',
        fullName: null,
        phoneNumber: null,
        nationalId: null,
        profileType: null,
        nationality: null,
        bookable: false,
      });
    });

    it('returns full data and bookable=true when profile is complete', async () => {
      const account = new AccountEntity();
      account.id = 'acc-123';
      account.bookable = true;
      account.fullName = 'Ahmed Hussein';
      account.phoneNumber = '01001234567';
      account.nationalId = '28505150101235';
      account.profileType = 'Regular';
      account.nationality = 'Egyptian';
      mockAccounts.findById.mockResolvedValue(account);

      const res = await service.getProfile('acc-123');
      expect(res).toEqual({
        accountId: 'acc-123',
        fullName: 'Ahmed Hussein',
        phoneNumber: '01001234567',
        nationalId: '28505150101235',
        profileType: 'Regular',
        nationality: 'Egyptian',
        bookable: true,
      });
    });

    it('rejects unknown account with UNAUTHORIZED', async () => {
      mockAccounts.findById.mockResolvedValue(null);
      await expect(service.getProfile('unknown')).rejects.toMatchObject({
        code: ErrorCode.UNAUTHORIZED,
      });
    });
  });

  describe('getProfileOptions', () => {
    it('returns all profile types and nationalities from lookup repos', async () => {
      const res = await service.getProfileOptions();
      expect(res.profileTypes).toEqual([
        { code: 'Regular', nameAr: 'عادي', nameEn: 'Regular' },
      ]);
      expect(res.nationalities).toEqual([
        { code: 'Egyptian', nameAr: 'مصري', nameEn: 'Egyptian' },
      ]);
    });
  });
});
