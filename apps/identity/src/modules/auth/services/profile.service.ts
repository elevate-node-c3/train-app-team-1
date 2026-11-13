import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  ErrorCode,
  type CompleteProfileRequestDto,
  type CompleteProfileResponseDto,
  type ProfileOptionsResponseDto,
  type ProfileResponseDto,
} from '@app/contracts';
import type { TransactionContext } from '@app/common/persistence/unit-of-work.port.js';
import {
  UNIT_OF_WORK,
  type UnitOfWorkPort,
} from '@app/common/persistence/unit-of-work.port.js';
import { OUTBOX, type OutboxPort } from '@app/messaging/outbox/outbox.port.js';
import { AuthError } from '../auth-error.js';
import { PassengerEntity } from '../entities/passenger.entity.js';
import { buildProfileCompleted } from '../identity-events.factory.js';
import { AccountRepository } from '../repositories/account.repository.js';
import { NationalityRepository } from '../repositories/nationality.repository.js';
import { PassengerRepository } from '../repositories/passenger.repository.js';
import { ProfileTypeRepository } from '../repositories/profile-type.repository.js';
import { SessionIssuer } from '../session.issuer.js';
import { validateProfile } from '../validators/profile-validation.js';

export interface CompleteProfileCommand extends CompleteProfileRequestDto {
  accountId: string;
  correlationId: string;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === '23505'
  );
}

function constraintOf(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'constraint' in error) {
    return String((error as { constraint: unknown }).constraint);
  }
  return '';
}

@Injectable()
export class ProfileService {
  constructor(
    @Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWorkPort,
    @Inject(OUTBOX) private readonly outbox: OutboxPort,
    private readonly accounts: AccountRepository,
    private readonly passengers: PassengerRepository,
    private readonly profileTypes: ProfileTypeRepository,
    private readonly nationalities: NationalityRepository,
    private readonly sessions: SessionIssuer,
  ) {}

  async completeProfile(
    command: CompleteProfileCommand,
  ): Promise<CompleteProfileResponseDto> {
    if (!command.accountId) {
      throw new AuthError(ErrorCode.UNAUTHORIZED);
    }

    const now = new Date();

    // 1. Validate references and fields in one pass (BR-10, BR-57)
    const [typeRecord, nationalityRecord] = await Promise.all([
      this.profileTypes.findByCode(command.profileType),
      this.nationalities.findByCode(command.nationality),
    ]);

    const validation = validateProfile(command, now, {
      profileTypeExists: typeRecord !== null,
      nationalityExists: nationalityRecord !== null,
    });

    if (validation.details.length > 0) {
      throw new AuthError(
        ErrorCode.VALIDATION_ERROR,
        undefined,
        undefined,
        validation.details,
      );
    }

    try {
      const outcome = await this.unitOfWork.withTransaction(async (ctx) => {
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
        if (account.emailVerifiedAt === null) {
          throw new AuthError(ErrorCode.EMAIL_NOT_VERIFIED);
        }
        if (account.bookable) {
          throw new AuthError(ErrorCode.PROFILE_ALREADY_COMPLETE);
        }

        // Check if national ID was already saved as a passenger for this account
        const existingPassenger =
          await this.passengers.findByAccountAndNationalId(
            ctx,
            account.id,
            validation.normalizedNationalId,
          );

        if (existingPassenger) {
          // Adopt existing passenger as self
          existingPassenger.isSelf = true;
          existingPassenger.fullName = validation.normalizedFullName;
          existingPassenger.profileType = command.profileType;
          existingPassenger.nationality = command.nationality;
          existingPassenger.updatedAt = now;
          await this.passengers.update(ctx, existingPassenger);
        } else {
          // Create new self passenger
          const passenger = new PassengerEntity();
          passenger.id = randomUUID();
          passenger.accountId = account.id;
          passenger.fullName = validation.normalizedFullName;
          passenger.nationalId = validation.normalizedNationalId;
          passenger.profileType = command.profileType;
          passenger.nationality = command.nationality;
          passenger.isSelf = true;
          passenger.createdAt = now;
          passenger.updatedAt = now;
          await this.passengers.save(ctx, passenger);
        }

        // Update account to bookable
        account.fullName = validation.normalizedFullName;
        account.phoneNumber = validation.canonicalPhone;
        account.nationalId = validation.normalizedNationalId;
        account.profileType = command.profileType;
        account.nationality = command.nationality;
        account.bookable = true;
        account.profileCompletedAt = now;
        await this.accounts.update(ctx, account);

        // Append domain event to outbox (accountId + fullName only)
        await this.outbox.append(
          ctx,
          buildProfileCompleted({
            eventId: randomUUID(),
            correlationId: command.correlationId,
            occurredAt: now,
            accountId: account.id,
            fullName: validation.normalizedFullName,
          }),
        );

        // Re-issue tokens with bkbl: true
        const issued = await this.sessions.issue(ctx, account, now);

        const profile: ProfileResponseDto = {
          accountId: account.id,
          fullName: account.fullName,
          phoneNumber: account.phoneNumber,
          nationalId: account.nationalId,
          profileType: account.profileType,
          nationality: account.nationality,
          bookable: account.bookable,
        };

        return { tokens: issued.tokens, profile };
      });

      return outcome;
    } catch (error: unknown) {
      if (error instanceof AuthError) {
        throw error;
      }

      if (isUniqueViolation(error)) {
        const constraint = constraintOf(error);
        if (constraint.includes('phone')) {
          throw new AuthError(ErrorCode.PHONE_ALREADY_REGISTERED);
        }
        if (constraint.includes('nid') || constraint.includes('national_id')) {
          throw new AuthError(ErrorCode.NATIONAL_ID_ALREADY_REGISTERED);
        }
        if (constraint.includes('self_account')) {
          throw new AuthError(ErrorCode.PROFILE_ALREADY_COMPLETE);
        }
      }

      throw error;
    }
  }

  async getProfile(accountId: string): Promise<ProfileResponseDto> {
    const account = await this.accounts.findById(accountId);
    if (!account) {
      throw new AuthError(ErrorCode.UNAUTHORIZED);
    }

    if (!account.bookable) {
      return {
        accountId: account.id,
        fullName: null,
        phoneNumber: null,
        nationalId: null,
        profileType: null,
        nationality: null,
        bookable: false,
      };
    }

    return {
      accountId: account.id,
      fullName: account.fullName,
      phoneNumber: account.phoneNumber,
      nationalId: account.nationalId,
      profileType: account.profileType,
      nationality: account.nationality,
      bookable: true,
    };
  }

  async getProfileOptions(): Promise<ProfileOptionsResponseDto> {
    const [types, nationalities] = await Promise.all([
      this.profileTypes.findAll(),
      this.nationalities.findAll(),
    ]);

    return {
      profileTypes: types.map((t) => ({
        code: t.code,
        nameAr: t.nameAr,
        nameEn: t.nameEn,
      })),
      nationalities: nationalities.map((n) => ({
        code: n.code,
        nameAr: n.nameAr,
        nameEn: n.nameEn,
      })),
    };
  }
}
