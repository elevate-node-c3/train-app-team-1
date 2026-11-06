import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorCode } from '@app/contracts';
import type { TransactionContext } from '@app/common/persistence/unit-of-work.port.js';
import { AuthError } from '../auth-error.js';
import { AccountEntity } from '../entities/account.entity.js';
import { PassengerEntity } from '../entities/passenger.entity.js';
import { ProfileTypeEntity } from '../entities/profile-type.entity.js';
import {
  PassengersService,
  type AddPassengerCommand,
  type UpdatePassengerCommand,
  type DeletePassengerCommand,
} from './passengers.service.js';

describe('PassengersService', () => {
  let service: PassengersService;
  let mockUnitOfWork: any;
  let mockBookingTicketCheck: any;
  let mockPassengers: any;
  let mockAccounts: any;
  let mockProfileTypes: any;

  const validSelfNid = '28505150101235'; // 1985-05-15, Cairo (01)
  const validCompanionNid1 = '29001010101235'; // 1990-01-01, Cairo (01)
  const validCompanionNid2 = '29502020101235'; // 1995-02-02, Cairo (01)

  const activeAccount = (): AccountEntity => {
    const acc = new AccountEntity();
    acc.id = 'acc-123';
    acc.email = 'traveller@example.com';
    acc.language = 'ar';
    acc.status = 'active';
    acc.bookable = true;
    acc.emailVerifiedAt = new Date();
    acc.fullName = 'Ahmed Hussein';
    acc.nationalId = validSelfNid;
    acc.profileType = 'Regular';
    acc.nationality = 'Egyptian';
    return acc;
  };

  const createPassengerEntity = (overrides: Partial<PassengerEntity> = {}): PassengerEntity => {
    const p = new PassengerEntity();
    p.id = overrides.id ?? 'pass-1';
    p.accountId = overrides.accountId ?? 'acc-123';
    p.fullName = overrides.fullName ?? 'Ali Hussein';
    p.nationalId = overrides.nationalId ?? validCompanionNid1;
    p.profileType = overrides.profileType ?? 'Regular';
    p.nationality = overrides.nationality ?? 'Egyptian';
    p.isSelf = overrides.isSelf ?? false;
    p.createdAt = overrides.createdAt ?? new Date('2026-01-01T10:00:00.000Z');
    p.updatedAt = overrides.updatedAt ?? new Date('2026-01-01T10:00:00.000Z');
    return p;
  };

  beforeEach(() => {
    mockUnitOfWork = {
      withTransaction: vi.fn(async (work: (ctx: TransactionContext) => Promise<any>) =>
        work({ driver: 'mock' } as TransactionContext),
      ),
    };

    mockBookingTicketCheck = {
      hasIssuedTickets: vi.fn().mockResolvedValue(false),
    };

    mockPassengers = {
      findAllByAccountId: vi.fn().mockResolvedValue([]),
      findByIdAndAccountId: vi.fn().mockResolvedValue(null),
      findByAccountAndNationalId: vi.fn().mockResolvedValue(null),
      countCompanionsByAccountId: vi.fn().mockResolvedValue(0),
      save: vi.fn().mockResolvedValue(undefined),
      update: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
    };

    mockAccounts = {
      findById: vi.fn().mockResolvedValue(activeAccount()),
      findByIdForUpdate: vi.fn().mockResolvedValue(activeAccount()),
      update: vi.fn().mockResolvedValue(undefined),
    };

    mockProfileTypes = {
      findByCode: vi.fn().mockImplementation(async (code: string) => {
        if (code === 'Regular') {
          const pt = new ProfileTypeEntity();
          pt.code = 'Regular';
          pt.nameAr = 'كوامل';
          pt.nameEn = 'Regular';
          return pt;
        }
        return null;
      }),
      findAll: vi.fn().mockResolvedValue([
        { code: 'Regular', nameAr: 'كوامل', nameEn: 'Regular' },
      ]),
    };

    service = new PassengersService(
      mockUnitOfWork,
      mockBookingTicketCheck,
      mockPassengers,
      mockAccounts,
      mockProfileTypes,
    );
  });

  describe('listPassengers', () => {
    it('returns self passenger first, followed by companions sorted by created_at ASC', async () => {
      const selfPassenger = createPassengerEntity({
        id: 'pass-self',
        fullName: 'Ahmed Hussein',
        nationalId: validSelfNid,
        isSelf: true,
        createdAt: new Date('2026-01-05T00:00:00.000Z'),
      });
      const companion1 = createPassengerEntity({
        id: 'pass-comp-1',
        fullName: 'Sara Ahmed',
        nationalId: validCompanionNid1,
        isSelf: false,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      });
      const companion2 = createPassengerEntity({
        id: 'pass-comp-2',
        fullName: 'Mona Ahmed',
        nationalId: validCompanionNid2,
        isSelf: false,
        createdAt: new Date('2026-01-02T00:00:00.000Z'),
      });

      // Repo returns self first, then companions by created_at ASC
      mockPassengers.findAllByAccountId.mockResolvedValue([
        selfPassenger,
        companion1,
        companion2,
      ]);

      const result = await service.listPassengers('acc-123', 'ar');

      expect(mockPassengers.findAllByAccountId).toHaveBeenCalledWith(null, 'acc-123');
      expect(result).toHaveLength(3);
      expect(result[0].id).toBe('pass-self');
      expect(result[0].isSelf).toBe(true);
      expect(result[0].typeName).toBe('كوامل');
      expect(result[1].id).toBe('pass-comp-1');
      expect(result[1].isSelf).toBe(false);
      expect(result[2].id).toBe('pass-comp-2');
      expect(result[2].isSelf).toBe(false);
    });

    it('resolves localized typeName to English when language is "en"', async () => {
      const passenger = createPassengerEntity({ isSelf: true });
      mockPassengers.findAllByAccountId.mockResolvedValue([passenger]);

      const result = await service.listPassengers('acc-123', 'en');

      expect(result[0].typeName).toBe('Regular');
    });

    it('resolves localized typeName to Arabic ("كوامل") by default when language is omitted', async () => {
      const passenger = createPassengerEntity({ isSelf: true });
      mockPassengers.findAllByAccountId.mockResolvedValue([passenger]);

      const result = await service.listPassengers('acc-123');

      expect(result[0].typeName).toBe('كوامل');
    });

    it('falls back to Arabic ("كوامل") for unsupported language codes', async () => {
      const passenger = createPassengerEntity({ isSelf: true });
      mockPassengers.findAllByAccountId.mockResolvedValue([passenger]);

      const result = await service.listPassengers('acc-123', 'fr');

      expect(result[0].typeName).toBe('كوامل');
    });

    it('returns empty array when account has no passengers', async () => {
      mockPassengers.findAllByAccountId.mockResolvedValue([]);

      const result = await service.listPassengers('acc-123', 'en');

      expect(result).toEqual([]);
    });

    it('rejects with UNAUTHORIZED if accountId is empty', async () => {
      await expect(service.listPassengers('')).rejects.toMatchObject({
        code: ErrorCode.UNAUTHORIZED,
      });
    });
  });

  describe('addPassenger', () => {
    const validAddCommand: AddPassengerCommand = {
      accountId: 'acc-123',
      fullName: 'Youssef Omar',
      nationalId: validCompanionNid1,
      profileType: 'Regular',
      language: 'ar',
    };

    it('adds a companion passenger successfully and returns PassengerDto', async () => {
      mockPassengers.countCompanionsByAccountId.mockResolvedValue(3);

      const result = await service.addPassenger(validAddCommand);

      expect(mockAccounts.findByIdForUpdate).toHaveBeenCalledWith(
        expect.anything(),
        'acc-123',
      );
      expect(mockPassengers.countCompanionsByAccountId).toHaveBeenCalledWith(
        expect.anything(),
        'acc-123',
      );
      expect(mockPassengers.save).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          accountId: 'acc-123',
          fullName: 'Youssef Omar',
          nationalId: validCompanionNid1,
          profileType: 'Regular',
          isSelf: false,
        }),
      );

      expect(result).toMatchObject({
        fullName: 'Youssef Omar',
        nationalId: validCompanionNid1,
        profileType: 'Regular',
        typeName: 'كوامل',
        isSelf: false,
      });
      expect(result.id).toBeDefined();
      expect(result.createdAt).toBeDefined();
    });

    it('normalizes Arabic digits in National ID', async () => {
      // '29001010101235' in Arabic-Indic digits
      const arabicDigitsNid = '٢٩٠٠١٠١٠١٠١٢٣٥';

      const result = await service.addPassenger({
        ...validAddCommand,
        nationalId: arabicDigitsNid,
      });

      expect(result.nationalId).toBe(validCompanionNid1);
      expect(mockPassengers.save).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          nationalId: validCompanionNid1,
        }),
      );
    });

    it('normalizes multiple whitespaces in fullName', async () => {
      const result = await service.addPassenger({
        ...validAddCommand,
        fullName: '   Youssef    Omar   ',
      });

      expect(result.fullName).toBe('Youssef Omar');
      expect(mockPassengers.save).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          fullName: 'Youssef Omar',
        }),
      );
    });

    it('allows unverified / non-bookable profile account to add companions', async () => {
      const unverifiedAccount = activeAccount();
      unverifiedAccount.bookable = false;
      unverifiedAccount.emailVerifiedAt = null;
      mockAccounts.findByIdForUpdate.mockResolvedValue(unverifiedAccount);

      const result = await service.addPassenger(validAddCommand);

      expect(result).toBeDefined();
      expect(mockPassengers.save).toHaveBeenCalled();
    });

    it('allows two different accounts to save the same companion National ID', async () => {
      // Account 1 saves the companion
      await service.addPassenger(validAddCommand);

      // Account 2 saves the same companion National ID
      const account2 = activeAccount();
      account2.id = 'acc-456';
      mockAccounts.findByIdForUpdate.mockResolvedValue(account2);
      mockPassengers.findByAccountAndNationalId.mockResolvedValue(null);

      const result2 = await service.addPassenger({
        ...validAddCommand,
        accountId: 'acc-456',
      });

      expect(result2).toBeDefined();
      expect(mockPassengers.save).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          accountId: 'acc-456',
          nationalId: validCompanionNid1,
        }),
      );
    });

    it('rejects with UNAUTHORIZED if accountId is missing', async () => {
      await expect(
        service.addPassenger({ ...validAddCommand, accountId: '' }),
      ).rejects.toMatchObject({
        code: ErrorCode.UNAUTHORIZED,
      });
    });

    it('rejects with UNAUTHORIZED if account is not found', async () => {
      mockAccounts.findByIdForUpdate.mockResolvedValue(null);

      await expect(service.addPassenger(validAddCommand)).rejects.toMatchObject({
        code: ErrorCode.UNAUTHORIZED,
      });
    });

    it('rejects with ACCOUNT_DISABLED if account is disabled', async () => {
      const disabledAccount = activeAccount();
      disabledAccount.status = 'disabled';
      mockAccounts.findByIdForUpdate.mockResolvedValue(disabledAccount);

      await expect(service.addPassenger(validAddCommand)).rejects.toMatchObject({
        code: ErrorCode.ACCOUNT_DISABLED,
      });
    });

    it('rejects invalid full name with INVALID_FULL_NAME (single word)', async () => {
      await expect(
        service.addPassenger({ ...validAddCommand, fullName: 'Youssef' }),
      ).rejects.toMatchObject({
        code: ErrorCode.INVALID_FULL_NAME,
      });
    });

    it('rejects invalid full name with INVALID_FULL_NAME (> 50 chars)', async () => {
      const longName = 'A'.repeat(51) + ' B';
      await expect(
        service.addPassenger({ ...validAddCommand, fullName: longName }),
      ).rejects.toMatchObject({
        code: ErrorCode.INVALID_FULL_NAME,
      });
    });

    it('rejects invalid full name with INVALID_FULL_NAME (contains special chars or numbers)', async () => {
      await expect(
        service.addPassenger({ ...validAddCommand, fullName: 'Ahmed 123' }),
      ).rejects.toMatchObject({
        code: ErrorCode.INVALID_FULL_NAME,
      });
    });

    it('rejects 11-digit Egyptian National ID sample 26582264865 with INVALID_NATIONAL_ID_LENGTH', async () => {
      await expect(
        service.addPassenger({ ...validAddCommand, nationalId: '26582264865' }),
      ).rejects.toMatchObject({
        code: ErrorCode.INVALID_NATIONAL_ID_LENGTH,
      });
    });

    it('rejects invalid National ID century with INVALID_NATIONAL_ID_CENTURY', async () => {
      // Starts with 4
      await expect(
        service.addPassenger({ ...validAddCommand, nationalId: '48505150101235' }),
      ).rejects.toMatchObject({
        code: ErrorCode.INVALID_NATIONAL_ID_CENTURY,
      });
    });

    it('rejects invalid National ID birth date with INVALID_NATIONAL_ID_BIRTH_DATE', async () => {
      // Month 13
      await expect(
        service.addPassenger({ ...validAddCommand, nationalId: '28513150101235' }),
      ).rejects.toMatchObject({
        code: ErrorCode.INVALID_NATIONAL_ID_BIRTH_DATE,
      });
    });

    it('rejects invalid National ID governorate with INVALID_NATIONAL_ID_GOVERNORATE', async () => {
      // Gov 99 does not exist
      await expect(
        service.addPassenger({ ...validAddCommand, nationalId: '28505159901235' }),
      ).rejects.toMatchObject({
        code: ErrorCode.INVALID_NATIONAL_ID_GOVERNORATE,
      });
    });

    it('rejects invalid profile type with INVALID_PROFILE_TYPE', async () => {
      await expect(
        service.addPassenger({ ...validAddCommand, profileType: 'NonExistent' }),
      ).rejects.toMatchObject({
        code: ErrorCode.INVALID_PROFILE_TYPE,
      });
    });

    it('rejects duplicate National ID in traveller list with NATIONAL_ID_ALREADY_REGISTERED', async () => {
      const existingPassenger = createPassengerEntity({
        nationalId: validCompanionNid1,
      });
      mockPassengers.findByAccountAndNationalId.mockResolvedValue(existingPassenger);

      await expect(service.addPassenger(validAddCommand)).rejects.toMatchObject({
        code: ErrorCode.NATIONAL_ID_ALREADY_REGISTERED,
      });
    });

    it('rejects 11th companion with PASSENGER_LIMIT_REACHED (preemptive check)', async () => {
      mockPassengers.countCompanionsByAccountId.mockResolvedValue(10);

      await expect(service.addPassenger(validAddCommand)).rejects.toMatchObject({
        code: ErrorCode.PASSENGER_LIMIT_REACHED,
      });
      expect(mockPassengers.save).not.toHaveBeenCalled();
    });

    it('catches DB trigger exception and maps to PASSENGER_LIMIT_REACHED', async () => {
      mockPassengers.countCompanionsByAccountId.mockResolvedValue(9);
      mockPassengers.save.mockRejectedValue(
        new Error('Account companion passenger limit of 10 reached: PASSENGER_LIMIT_REACHED'),
      );

      await expect(service.addPassenger(validAddCommand)).rejects.toMatchObject({
        code: ErrorCode.PASSENGER_LIMIT_REACHED,
      });
    });

    it('catches DB unique violation on national_id and maps to NATIONAL_ID_ALREADY_REGISTERED', async () => {
      mockPassengers.save.mockRejectedValue({
        code: '23505',
        constraint: 'uq_passenger_nid_account',
      });

      await expect(service.addPassenger(validAddCommand)).rejects.toMatchObject({
        code: ErrorCode.NATIONAL_ID_ALREADY_REGISTERED,
      });
    });
  });

  describe('updatePassenger', () => {
    const validUpdateCommand: UpdatePassengerCommand = {
      passengerId: 'pass-comp-1',
      accountId: 'acc-123',
      fullName: 'Sara Omar',
      nationalId: validCompanionNid2,
      profileType: 'Regular',
      language: 'en',
    };

    it('updates companion passenger successfully without ticket check or account sync', async () => {
      const companion = createPassengerEntity({
        id: 'pass-comp-1',
        accountId: 'acc-123',
        fullName: 'Sara Ahmed',
        nationalId: validCompanionNid1,
        isSelf: false,
      });
      mockPassengers.findByIdAndAccountId.mockResolvedValue(companion);

      const result = await service.updatePassenger(validUpdateCommand);

      expect(mockBookingTicketCheck.hasIssuedTickets).not.toHaveBeenCalled();
      expect(mockAccounts.update).not.toHaveBeenCalled();
      expect(mockPassengers.update).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          id: 'pass-comp-1',
          fullName: 'Sara Omar',
          nationalId: validCompanionNid2,
        }),
      );
      expect(result).toMatchObject({
        id: 'pass-comp-1',
        fullName: 'Sara Omar',
        nationalId: validCompanionNid2,
        typeName: 'Regular',
        isSelf: false,
      });
    });

    it('rejects with PASSENGER_NOT_FOUND (404) if passenger ID does not exist', async () => {
      mockPassengers.findByIdAndAccountId.mockResolvedValue(null);

      await expect(service.updatePassenger(validUpdateCommand)).rejects.toMatchObject({
        code: ErrorCode.PASSENGER_NOT_FOUND,
      });
    });

    it('rejects with PASSENGER_NOT_FOUND (404) if passenger belongs to another account', async () => {
      mockPassengers.findByIdAndAccountId.mockResolvedValue(null);

      await expect(
        service.updatePassenger({ ...validUpdateCommand, accountId: 'other-acc' }),
      ).rejects.toMatchObject({
        code: ErrorCode.PASSENGER_NOT_FOUND,
      });
    });

    it('rejects updating National ID to one already present in traveller list with NATIONAL_ID_ALREADY_REGISTERED', async () => {
      const companion = createPassengerEntity({
        id: 'pass-comp-1',
        accountId: 'acc-123',
        nationalId: validCompanionNid1,
        isSelf: false,
      });
      mockPassengers.findByIdAndAccountId.mockResolvedValue(companion);

      // Another companion has validCompanionNid2
      const existingPassenger = createPassengerEntity({
        id: 'pass-comp-2',
        accountId: 'acc-123',
        nationalId: validCompanionNid2,
      });
      mockPassengers.findByAccountAndNationalId.mockResolvedValue(existingPassenger);

      await expect(service.updatePassenger(validUpdateCommand)).rejects.toMatchObject({
        code: ErrorCode.NATIONAL_ID_ALREADY_REGISTERED,
      });
    });

    it('updates self passenger and syncs account atomically when National ID unchanged', async () => {
      const selfPassenger = createPassengerEntity({
        id: 'pass-self',
        accountId: 'acc-123',
        fullName: 'Ahmed Hussein',
        nationalId: validSelfNid,
        isSelf: true,
      });
      mockPassengers.findByIdAndAccountId.mockResolvedValue(selfPassenger);

      const command: UpdatePassengerCommand = {
        passengerId: 'pass-self',
        accountId: 'acc-123',
        fullName: 'Ahmed Hassan Hussein',
        nationalId: validSelfNid, // Unchanged
        profileType: 'Regular',
        language: 'ar',
      };

      const result = await service.updatePassenger(command);

      // Ticket check not performed when NID is not modified
      expect(mockBookingTicketCheck.hasIssuedTickets).not.toHaveBeenCalled();
      // Account updated
      expect(mockAccounts.update).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          id: 'acc-123',
          fullName: 'Ahmed Hassan Hussein',
          nationalId: validSelfNid,
        }),
      );
      // Passenger updated
      expect(mockPassengers.update).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          id: 'pass-self',
          fullName: 'Ahmed Hassan Hussein',
        }),
      );
      expect(result.fullName).toBe('Ahmed Hassan Hussein');
    });

    it('refuses self National ID change if ticket was issued (NATIONAL_ID_LOCKED)', async () => {
      const selfPassenger = createPassengerEntity({
        id: 'pass-self',
        accountId: 'acc-123',
        fullName: 'Ahmed Hussein',
        nationalId: validSelfNid,
        isSelf: true,
      });
      mockPassengers.findByIdAndAccountId.mockResolvedValue(selfPassenger);
      mockBookingTicketCheck.hasIssuedTickets.mockResolvedValue(true);

      const newNid = '29001010101235';
      const command: UpdatePassengerCommand = {
        passengerId: 'pass-self',
        accountId: 'acc-123',
        fullName: 'Ahmed Hussein',
        nationalId: newNid, // Changed
        profileType: 'Regular',
      };

      await expect(service.updatePassenger(command)).rejects.toMatchObject({
        code: ErrorCode.NATIONAL_ID_LOCKED,
      });

      expect(mockBookingTicketCheck.hasIssuedTickets).toHaveBeenCalledWith(validSelfNid);
      expect(mockAccounts.update).not.toHaveBeenCalled();
      expect(mockPassengers.update).not.toHaveBeenCalled();
    });

    it('allows modifying self National ID if no tickets are issued and syncs account', async () => {
      const selfPassenger = createPassengerEntity({
        id: 'pass-self',
        accountId: 'acc-123',
        fullName: 'Ahmed Hussein',
        nationalId: validSelfNid,
        isSelf: true,
      });
      mockPassengers.findByIdAndAccountId.mockResolvedValue(selfPassenger);
      mockBookingTicketCheck.hasIssuedTickets.mockResolvedValue(false);

      const newNid = '29001010101235';
      const command: UpdatePassengerCommand = {
        passengerId: 'pass-self',
        accountId: 'acc-123',
        fullName: 'Ahmed Hussein',
        nationalId: newNid,
        profileType: 'Regular',
      };

      const result = await service.updatePassenger(command);

      expect(mockBookingTicketCheck.hasIssuedTickets).toHaveBeenCalledWith(validSelfNid);
      expect(mockAccounts.update).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          id: 'acc-123',
          nationalId: newNid,
        }),
      );
      expect(mockPassengers.update).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          id: 'pass-self',
          nationalId: newNid,
        }),
      );
      expect(result.nationalId).toBe(newNid);
    });

    it('rejects self National ID change if already taken by another account (DB unique constraint) with NATIONAL_ID_ALREADY_REGISTERED', async () => {
      const selfPassenger = createPassengerEntity({
        id: 'pass-self',
        accountId: 'acc-123',
        nationalId: validSelfNid,
        isSelf: true,
      });
      mockPassengers.findByIdAndAccountId.mockResolvedValue(selfPassenger);
      mockBookingTicketCheck.hasIssuedTickets.mockResolvedValue(false);

      mockAccounts.update.mockRejectedValue({
        code: '23505',
        constraint: 'uq_account_national_id',
      });

      const command: UpdatePassengerCommand = {
        passengerId: 'pass-self',
        accountId: 'acc-123',
        fullName: 'Ahmed Hussein',
        nationalId: validCompanionNid1,
        profileType: 'Regular',
      };

      await expect(service.updatePassenger(command)).rejects.toMatchObject({
        code: ErrorCode.NATIONAL_ID_ALREADY_REGISTERED,
      });
    });

    it('rejects invalid full name on update with INVALID_FULL_NAME', async () => {
      await expect(
        service.updatePassenger({ ...validUpdateCommand, fullName: 'SingleWord' }),
      ).rejects.toMatchObject({
        code: ErrorCode.INVALID_FULL_NAME,
      });
    });

    it('rejects invalid National ID on update with INVALID_NATIONAL_ID_LENGTH', async () => {
      await expect(
        service.updatePassenger({ ...validUpdateCommand, nationalId: '123' }),
      ).rejects.toMatchObject({
        code: ErrorCode.INVALID_NATIONAL_ID_LENGTH,
      });
    });

    it('rejects invalid profile type on update with INVALID_PROFILE_TYPE', async () => {
      await expect(
        service.updatePassenger({ ...validUpdateCommand, profileType: 'InvalidType' }),
      ).rejects.toMatchObject({
        code: ErrorCode.INVALID_PROFILE_TYPE,
      });
    });
  });

  describe('deletePassenger', () => {
    const validDeleteCommand: DeletePassengerCommand = {
      passengerId: 'pass-comp-1',
      accountId: 'acc-123',
    };

    it('deletes companion passenger successfully', async () => {
      const companion = createPassengerEntity({
        id: 'pass-comp-1',
        accountId: 'acc-123',
        isSelf: false,
      });
      mockPassengers.findByIdAndAccountId.mockResolvedValue(companion);

      await service.deletePassenger(validDeleteCommand);

      expect(mockPassengers.findByIdAndAccountId).toHaveBeenCalledWith(
        expect.anything(),
        'pass-comp-1',
        'acc-123',
        { forUpdate: true },
      );
      expect(mockPassengers.delete).toHaveBeenCalledWith(
        expect.anything(),
        'pass-comp-1',
      );
    });

    it('rejects deleting self passenger with CANNOT_DELETE_SELF_PASSENGER', async () => {
      const selfPassenger = createPassengerEntity({
        id: 'pass-self',
        accountId: 'acc-123',
        isSelf: true,
      });
      mockPassengers.findByIdAndAccountId.mockResolvedValue(selfPassenger);

      await expect(
        service.deletePassenger({
          passengerId: 'pass-self',
          accountId: 'acc-123',
        }),
      ).rejects.toMatchObject({
        code: ErrorCode.CANNOT_DELETE_SELF_PASSENGER,
      });

      expect(mockPassengers.delete).not.toHaveBeenCalled();
    });

    it('rejects with PASSENGER_NOT_FOUND (404) if passenger does not exist', async () => {
      mockPassengers.findByIdAndAccountId.mockResolvedValue(null);

      await expect(service.deletePassenger(validDeleteCommand)).rejects.toMatchObject({
        code: ErrorCode.PASSENGER_NOT_FOUND,
      });

      expect(mockPassengers.delete).not.toHaveBeenCalled();
    });

    it('rejects with PASSENGER_NOT_FOUND (404) if passenger belongs to another account', async () => {
      mockPassengers.findByIdAndAccountId.mockResolvedValue(null);

      await expect(
        service.deletePassenger({
          passengerId: 'pass-comp-1',
          accountId: 'another-acc',
        }),
      ).rejects.toMatchObject({
        code: ErrorCode.PASSENGER_NOT_FOUND,
      });

      expect(mockPassengers.delete).not.toHaveBeenCalled();
    });

    it('rejects with UNAUTHORIZED if accountId is missing', async () => {
      await expect(
        service.deletePassenger({ passengerId: 'pass-1', accountId: '' }),
      ).rejects.toMatchObject({
        code: ErrorCode.UNAUTHORIZED,
      });
    });
  });
});
