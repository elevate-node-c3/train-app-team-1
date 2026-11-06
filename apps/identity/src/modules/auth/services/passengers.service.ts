import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  ErrorCode,
  type PassengerDto,
} from '@app/contracts';
import {
  UNIT_OF_WORK,
  type UnitOfWorkPort,
} from '@app/common/persistence/unit-of-work.port.js';
import { AuthError } from '../auth-error.js';
import {
  BOOKING_TICKET_CHECK,
  type BookingTicketCheckPort,
} from '../booking-ticket-check.adapter.js';
import { PassengerEntity } from '../entities/passenger.entity.js';
import { AccountRepository } from '../repositories/account.repository.js';
import { PassengerRepository } from '../repositories/passenger.repository.js';
import { ProfileTypeRepository } from '../repositories/profile-type.repository.js';
import { validateFullName } from '../validators/full-name.validator.js';
import { validateNationalId } from '../validators/national-id.validator.js';

export interface AddPassengerCommand {
  accountId: string;
  fullName: string;
  nationalId: string;
  profileType: string;
  language?: string;
}

export interface UpdatePassengerCommand {
  passengerId: string;
  accountId: string;
  fullName: string;
  nationalId: string;
  profileType: string;
  language?: string;
}

export interface DeletePassengerCommand {
  passengerId: string;
  accountId: string;
}

function isUniqueViolation(error: unknown): boolean {
  if (typeof error === 'object' && error !== null) {
    const err = error as { code?: unknown; driverError?: { code?: unknown } };
    return err.code === '23505' || err.driverError?.code === '23505';
  }
  return false;
}

function constraintOf(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const err = error as { constraint?: unknown; driverError?: { constraint?: unknown } };
    return String(err.constraint || err.driverError?.constraint || '');
  }
  return '';
}

function isLimitViolation(error: unknown): boolean {
  if (typeof error === 'object' && error !== null) {
    const err = error as { message?: unknown; detail?: unknown };
    const msg = typeof err.message === 'string' ? err.message : '';
    const detail = typeof err.detail === 'string' ? err.detail : '';
    if (
      msg.includes('PASSENGER_LIMIT_REACHED') ||
      msg.includes('Account companion passenger limit') ||
      detail.includes('PASSENGER_LIMIT_REACHED')
    ) {
      return true;
    }
  }
  return false;
}

@Injectable()
export class PassengersService {
  constructor(
    @Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWorkPort,
    @Inject(BOOKING_TICKET_CHECK)
    private readonly bookingTicketCheck: BookingTicketCheckPort,
    private readonly passengers: PassengerRepository,
    private readonly accounts: AccountRepository,
    private readonly profileTypes: ProfileTypeRepository,
  ) {}

  async listPassengers(
    accountId: string,
    language?: string,
  ): Promise<PassengerDto[]> {
    if (!accountId) {
      throw new AuthError(ErrorCode.UNAUTHORIZED);
    }

    const [passengers, profileTypes] = await Promise.all([
      this.passengers.findAllByAccountId(null, accountId),
      this.profileTypes.findAll(),
    ]);

    const typeMap = new Map(profileTypes.map((pt) => [pt.code, pt]));
    const lang = language === 'en' ? 'en' : 'ar';

    return passengers.map((p) => {
      const typeRecord = typeMap.get(p.profileType);
      const typeName = typeRecord
        ? (lang === 'en' ? typeRecord.nameEn : typeRecord.nameAr)
        : p.profileType;

      return {
        id: p.id,
        fullName: p.fullName,
        nationalId: p.nationalId,
        profileType: p.profileType,
        typeName,
        isSelf: p.isSelf,
        createdAt:
          p.createdAt instanceof Date
            ? p.createdAt.toISOString()
            : new Date(p.createdAt).toISOString(),
      };
    });
  }

  async addPassenger(command: AddPassengerCommand): Promise<PassengerDto> {
    if (!command.accountId) {
      throw new AuthError(ErrorCode.UNAUTHORIZED);
    }

    const now = new Date();

    const nameResult = validateFullName(command.fullName);
    if (!nameResult.valid) {
      throw new AuthError(ErrorCode.INVALID_FULL_NAME);
    }

    const nidResult = validateNationalId(command.nationalId, now);
    if (!nidResult.valid) {
      throw new AuthError(nidResult.errors[0]);
    }

    const typeRecord = await this.profileTypes.findByCode(command.profileType);
    if (!typeRecord) {
      throw new AuthError(ErrorCode.INVALID_PROFILE_TYPE);
    }

    try {
      return await this.unitOfWork.withTransaction(async (ctx) => {
        const account = await this.accounts.findByIdForUpdate(
          ctx,
          command.accountId,
        );
        if (!account) {
          throw new AuthError(ErrorCode.UNAUTHORIZED);
        }
        if (account.status === 'disabled') {
          throw new AuthError(ErrorCode.ACCOUNT_DISABLED);
        }

        const existing = await this.passengers.findByAccountAndNationalId(
          ctx,
          account.id,
          nidResult.normalized,
        );
        if (existing) {
          throw new AuthError(ErrorCode.NATIONAL_ID_ALREADY_REGISTERED);
        }

        const companionCount =
          await this.passengers.countCompanionsByAccountId(ctx, account.id);
        if (companionCount >= 10) {
          throw new AuthError(ErrorCode.PASSENGER_LIMIT_REACHED);
        }

        const passenger = new PassengerEntity();
        passenger.id = randomUUID();
        passenger.accountId = account.id;
        passenger.fullName = nameResult.normalized;
        passenger.nationalId = nidResult.normalized;
        passenger.profileType = command.profileType;
        passenger.nationality = 'Egyptian';
        passenger.isSelf = false;
        passenger.createdAt = now;
        passenger.updatedAt = now;

        await this.passengers.save(ctx, passenger);

        const lang = command.language === 'en' ? 'en' : 'ar';
        const typeName = lang === 'en' ? typeRecord.nameEn : typeRecord.nameAr;

        return {
          id: passenger.id,
          fullName: passenger.fullName,
          nationalId: passenger.nationalId,
          profileType: passenger.profileType,
          typeName,
          isSelf: passenger.isSelf,
          createdAt: passenger.createdAt.toISOString(),
        };
      });
    } catch (error: unknown) {
      if (error instanceof AuthError) {
        throw error;
      }

      if (isLimitViolation(error)) {
        throw new AuthError(ErrorCode.PASSENGER_LIMIT_REACHED);
      }

      if (isUniqueViolation(error)) {
        const constraint = constraintOf(error);
        if (constraint.includes('nid') || constraint.includes('national_id')) {
          throw new AuthError(ErrorCode.NATIONAL_ID_ALREADY_REGISTERED);
        }
      }

      throw error;
    }
  }

  async updatePassenger(command: UpdatePassengerCommand): Promise<PassengerDto> {
    if (!command.accountId) {
      throw new AuthError(ErrorCode.UNAUTHORIZED);
    }

    const now = new Date();

    const nameResult = validateFullName(command.fullName);
    if (!nameResult.valid) {
      throw new AuthError(ErrorCode.INVALID_FULL_NAME);
    }

    const nidResult = validateNationalId(command.nationalId, now);
    if (!nidResult.valid) {
      throw new AuthError(nidResult.errors[0]);
    }

    const typeRecord = await this.profileTypes.findByCode(command.profileType);
    if (!typeRecord) {
      throw new AuthError(ErrorCode.INVALID_PROFILE_TYPE);
    }

    try {
      return await this.unitOfWork.withTransaction(async (ctx) => {
        const passenger = await this.passengers.findByIdAndAccountId(
          ctx,
          command.passengerId,
          command.accountId,
          { forUpdate: true },
        );
        if (!passenger) {
          throw new AuthError(ErrorCode.PASSENGER_NOT_FOUND);
        }

        const nationalIdChanged = passenger.nationalId !== nidResult.normalized;

        if (nationalIdChanged) {
          const duplicate = await this.passengers.findByAccountAndNationalId(
            ctx,
            command.accountId,
            nidResult.normalized,
          );
          if (duplicate && duplicate.id !== passenger.id) {
            throw new AuthError(ErrorCode.NATIONAL_ID_ALREADY_REGISTERED);
          }
        }

        if (passenger.isSelf) {
          if (nationalIdChanged) {
            const hasTickets = await this.bookingTicketCheck.hasIssuedTickets(
              passenger.nationalId,
            );
            if (hasTickets) {
              throw new AuthError(ErrorCode.NATIONAL_ID_LOCKED);
            }
          }

          const account = await this.accounts.findByIdForUpdate(
            ctx,
            command.accountId,
          );
          if (!account) {
            throw new AuthError(ErrorCode.UNAUTHORIZED);
          }
          account.fullName = nameResult.normalized;
          account.nationalId = nidResult.normalized;
          account.profileType = command.profileType;
          await this.accounts.update(ctx, account);
        }

        passenger.fullName = nameResult.normalized;
        passenger.nationalId = nidResult.normalized;
        passenger.profileType = command.profileType;
        passenger.updatedAt = now;

        await this.passengers.update(ctx, passenger);

        const lang = command.language === 'en' ? 'en' : 'ar';
        const typeName = lang === 'en' ? typeRecord.nameEn : typeRecord.nameAr;

        return {
          id: passenger.id,
          fullName: passenger.fullName,
          nationalId: passenger.nationalId,
          profileType: passenger.profileType,
          typeName,
          isSelf: passenger.isSelf,
          createdAt:
            passenger.createdAt instanceof Date
              ? passenger.createdAt.toISOString()
              : new Date(passenger.createdAt).toISOString(),
        };
      });
    } catch (error: unknown) {
      if (error instanceof AuthError) {
        throw error;
      }

      if (isLimitViolation(error)) {
        throw new AuthError(ErrorCode.PASSENGER_LIMIT_REACHED);
      }

      if (isUniqueViolation(error)) {
        const constraint = constraintOf(error);
        if (constraint.includes('nid') || constraint.includes('national_id')) {
          throw new AuthError(ErrorCode.NATIONAL_ID_ALREADY_REGISTERED);
        }
      }

      throw error;
    }
  }

  async deletePassenger(command: DeletePassengerCommand): Promise<void> {
    if (!command.accountId) {
      throw new AuthError(ErrorCode.UNAUTHORIZED);
    }

    await this.unitOfWork.withTransaction(async (ctx) => {
      const passenger = await this.passengers.findByIdAndAccountId(
        ctx,
        command.passengerId,
        command.accountId,
        { forUpdate: true },
      );
      if (!passenger) {
        throw new AuthError(ErrorCode.PASSENGER_NOT_FOUND);
      }
      if (passenger.isSelf) {
        throw new AuthError(ErrorCode.CANNOT_DELETE_SELF_PASSENGER);
      }

      await this.passengers.delete(ctx, passenger.id);
    });
  }
}
