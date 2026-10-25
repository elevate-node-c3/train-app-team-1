import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  ErrorCode,
  passwordPolicyViolations,
  type EventLanguage,
  type SignUpRequestDto,
  type SignUpResponseDto,
} from '@app/contracts';
import { maskEmail } from '@app/common/logging/pii-redactor.js';
import {
  UNIT_OF_WORK,
  type UnitOfWorkPort,
} from '@app/common/persistence/unit-of-work.port.js';
import {
  OUTBOX,
  type OutboxPort,
} from '@app/messaging/outbox/outbox.port.js';
import { Account } from '../../domain/account.js';
import { buildAccountRegistered } from '../../domain/events/identity-events.factory.js';
import { AuthError } from '../auth-error.js';
import {
  ACCOUNT_REPOSITORY,
  type AccountRepositoryPort,
} from '../ports/account.repository.port.js';
import {
  PASSWORD_HASHER,
  type PasswordHasherPort,
} from '../ports/password-hasher.port.js';
import { VerificationCodeIssuer } from '../services/verification-code.issuer.js';
import { VerificationRatePolicy } from '../services/verification-rate.policy.js';

export interface SignUpCommand extends SignUpRequestDto {
  correlationId: string;
}

/** BR-56: anything that is not English falls back to Arabic. */
function languageOf(language: string | undefined): EventLanguage {
  return language === 'en' ? 'en' : 'ar';
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === '23505'
  );
}

/**
 * Sign-up writes the account, the code hash, the request counter and the
 * outbox row in one transaction. The password is hashed and the code prepared
 * before the transaction opens; neither CPU-bound step holds a row lock.
 */
@Injectable()
export class SignUpUseCase {
  constructor(
    @Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWorkPort,
    @Inject(ACCOUNT_REPOSITORY) private readonly accounts: AccountRepositoryPort,
    @Inject(PASSWORD_HASHER) private readonly passwords: PasswordHasherPort,
    private readonly codes: VerificationCodeIssuer,
    private readonly ratePolicy: VerificationRatePolicy,
    @Inject(OUTBOX) private readonly outbox: OutboxPort,
  ) {}

  async execute(command: SignUpCommand): Promise<SignUpResponseDto> {
    const policy = passwordPolicyViolations(command.password);
    if (policy.length > 0) {
      throw new AuthError(
        ErrorCode.VALIDATION_ERROR,
        policy.map((violation) => violation.message).join('; '),
      );
    }

    const now = new Date();
    const language = languageOf(command.language);
    const existing = await this.accounts.findByEmail(command.email);

    if (existing) {
      return this.reissueForPending(existing, command, language, now);
    }

    const passwordHash = await this.passwords.hash(command.password);
    const account = Account.register({
      id: randomUUID(),
      email: command.email,
      language,
      createdAt: now,
      passwordHash,
      passwordUpdatedAt: now,
    });
    const prepared = this.codes.prepare(account.id, 'sign_up', now);

    try {
      await this.unitOfWork.withTransaction(async (ctx) => {
        await this.accounts.save(ctx, account);
        await this.codes.issue(ctx, {
          account,
          purpose: 'sign_up',
          prepared,
          correlationId: command.correlationId,
          now,
        });
        await this.outbox.append(
          ctx,
          buildAccountRegistered({
            eventId: randomUUID(),
            correlationId: command.correlationId,
            occurredAt: now,
            accountId: account.id,
            email: account.email,
            language: account.language,
          }),
        );
      });
    } catch (error: unknown) {
      // Two simultaneous sign-ups for one address: the database's lower(email)
      // index decides, and the loser gets the documented conflict.
      if (isUniqueViolation(error)) {
        throw new AuthError(ErrorCode.EMAIL_ALREADY_REGISTERED);
      }
      throw error;
    }

    return this.responseFor(account);
  }

  /**
   * An unverified account may sign up again. Its credentials are replaced in
   * place, every live code dies, and the resend window still applies — this is
   * not a way to bypass the durable counter.
   */
  private async reissueForPending(
    existing: Account,
    command: SignUpCommand,
    language: EventLanguage,
    now: Date,
  ): Promise<SignUpResponseDto> {
    if (existing.isDisabled()) {
      throw new AuthError(ErrorCode.ACCOUNT_DISABLED);
    }
    if (!existing.isPending()) {
      throw new AuthError(ErrorCode.EMAIL_ALREADY_REGISTERED);
    }

    const decision = await this.ratePolicy.evaluate(
      existing.email,
      'sign_up',
      now,
    );
    if (!decision.allowed) {
      throw new AuthError(
        ErrorCode.RESEND_TOO_SOON,
        'A verification code was issued recently',
        decision.secondsRemaining,
      );
    }

    const passwordHash = await this.passwords.hash(command.password);
    const prepared = this.codes.prepare(existing.id, 'sign_up', now);

    await this.unitOfWork.withTransaction(async (ctx) => {
      const locked = await this.accounts.findByEmailForUpdate(
        ctx,
        existing.email,
      );
      if (!locked) {
        throw new AuthError(ErrorCode.RESOURCE_NOT_FOUND);
      }
      if (locked.isDisabled()) {
        throw new AuthError(ErrorCode.ACCOUNT_DISABLED);
      }
      if (!locked.isPending()) {
        throw new AuthError(ErrorCode.EMAIL_ALREADY_REGISTERED);
      }

      const updated = locked.replacePendingCredentials(
        passwordHash,
        language,
        now,
      );
      await this.accounts.update(ctx, updated);
      await this.codes.issue(ctx, {
        account: updated,
        purpose: 'sign_up',
        prepared,
        correlationId: command.correlationId,
        now,
      });
    });

    return {
      accountId: existing.id,
      maskedEmail: maskEmail(existing.email),
      language,
      resendAfterSeconds: this.ratePolicy.nextAllowedSeconds(),
    };
  }

  private responseFor(account: Account): SignUpResponseDto {
    return {
      accountId: account.id,
      maskedEmail: maskEmail(account.email),
      language: account.language,
      resendAfterSeconds: this.ratePolicy.nextAllowedSeconds(),
    };
  }
}
