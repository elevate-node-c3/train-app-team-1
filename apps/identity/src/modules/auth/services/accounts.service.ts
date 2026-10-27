import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  ErrorCode,
  passwordPolicyViolations,
  type EventLanguage,
  type ResendVerificationRequestDto,
  type ResendVerificationResponseDto,
  type SignUpRequestDto,
  type SignUpResponseDto,
  type VerifyEmailRequestDto,
  type VerifyEmailResponseDto,
} from '@app/contracts';
import { maskEmail } from '@app/common/logging/pii-redactor.js';
import type { TransactionContext } from '@app/common/persistence/unit-of-work.port.js';
import {
  UNIT_OF_WORK,
  type UnitOfWorkPort,
} from '@app/common/persistence/unit-of-work.port.js';
import { OUTBOX, type OutboxPort } from '@app/messaging/outbox/outbox.port.js';
import { AuthError } from '../auth-error.js';
import { BcryptPasswordHasher } from '../bcrypt-password.hasher.js';
import { AccountEntity } from '../entities/account.entity.js';
import type { VerificationCodeEntity } from '../entities/verification-code.entity.js';
import {
  buildAccountRegistered,
  buildEmailVerified,
} from '../identity-events.factory.js';
import { AccountRepository } from '../repositories/account.repository.js';
import { VerificationCodeRepository } from '../repositories/verification-code.repository.js';
import { SessionIssuer, type IssuedTokens } from '../session.issuer.js';
import { verifyVerificationCode } from '../verification-code.hashing.js';
import { VerificationCodeIssuer } from '../verification-code.issuer.js';
import { VerificationRatePolicy } from '../verification-rate.policy.js';

export interface SignUpCommand extends SignUpRequestDto {
  correlationId: string;
}

export interface VerifyEmailCommand extends VerifyEmailRequestDto {
  correlationId: string;
}

export interface ResendVerificationCommand extends ResendVerificationRequestDto {
  correlationId: string;
}

type VerifyOutcome =
  { failed: AuthError } | { account: AccountEntity; issued: IssuedTokens };

/** BR-56: anything that is not English falls back to Arabic. */
function languageOf(language: string | undefined): EventLanguage {
  return language === 'en' ? 'en' : 'ar';
}

/**
 * Email is normalized on the way in. The database also has a unique index on
 * `lower(email)`, so a repository bug cannot create two accounts for one
 * mailbox.
 */
function normalizeEmail(value: string): string {
  const email = value.trim().toLowerCase();
  if (!email.includes('@')) {
    throw new Error('A valid email address is required');
  }
  return email;
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
export class AccountsService {
  constructor(
    @Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWorkPort,
    private readonly accounts: AccountRepository,
    private readonly passwords: BcryptPasswordHasher,
    private readonly codes: VerificationCodeRepository,
    private readonly issuer: VerificationCodeIssuer,
    private readonly ratePolicy: VerificationRatePolicy,
    private readonly sessions: SessionIssuer,
    @Inject(OUTBOX) private readonly outbox: OutboxPort,
  ) {}

  async signUp(command: SignUpCommand): Promise<SignUpResponseDto> {
    const policy = passwordPolicyViolations(command.password);
    if (policy.length > 0) {
      throw new AuthError(
        ErrorCode.VALIDATION_ERROR,
        policy.map((violation) => violation.message).join('; '),
      );
    }

    const now = new Date();
    const language = languageOf(command.language);
    const email = normalizeEmail(command.email);
    const existing = await this.accounts.findByEmail(email);

    if (existing) {
      return this.reissueForPending(existing, command, email, language, now);
    }

    const passwordHash = await this.passwords.hash(command.password);
    const account = new AccountEntity();
    account.id = randomUUID();
    account.email = email;
    account.language = language;
    account.status = 'pending';
    account.createdAt = now;
    account.passwordHash = passwordHash;
    account.passwordUpdatedAt = now;
    account.emailVerifiedAt = null;
    account.bookable = false;
    account.roles = [];

    const prepared = this.issuer.prepare(account.id, 'sign_up', now);

    try {
      await this.unitOfWork.withTransaction(async (ctx) => {
        await this.accounts.save(ctx, account);
        await this.issuer.issue(ctx, {
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

  async verifyEmail(
    command: VerifyEmailCommand,
  ): Promise<VerifyEmailResponseDto> {
    const now = new Date();

    const outcome = await this.unitOfWork.withTransaction(
      async (ctx): Promise<VerifyOutcome> => {
        const account = await this.accounts.findByEmailForUpdate(
          ctx,
          command.email,
        );
        if (!account) {
          return { failed: new AuthError(ErrorCode.INVALID_VERIFICATION_CODE) };
        }
        if (account.status === 'disabled') {
          return { failed: new AuthError(ErrorCode.ACCOUNT_DISABLED) };
        }

        const code = await this.codes.findLatestLive(
          ctx,
          account.id,
          'sign_up',
          { forUpdate: true },
        );
        const failure = await this.checkCode(ctx, code, command.code, now);
        if (failure) return { failed: failure };

        code!.consumedAt = now;
        await this.codes.update(ctx, code!);

        account.status = 'active';
        account.emailVerifiedAt = now;
        await this.accounts.update(ctx, account);

        const issued = await this.sessions.issue(ctx, account, now);

        await this.outbox.append(
          ctx,
          buildEmailVerified({
            eventId: randomUUID(),
            correlationId: command.correlationId,
            occurredAt: now,
            accountId: account.id,
            email: account.email,
          }),
        );

        return { account, issued };
      },
    );

    if ('failed' in outcome) throw outcome.failed;

    return {
      ...outcome.issued.tokens,
      accountId: outcome.account.id,
      maskedEmail: maskEmail(outcome.account.email),
    };
  }

  async resendVerification(
    command: ResendVerificationCommand,
  ): Promise<ResendVerificationResponseDto> {
    const now = new Date();
    const email = command.email.trim().toLowerCase();
    const existing = await this.accounts.findByEmail(email);
    if (!existing) throw new AuthError(ErrorCode.RESOURCE_NOT_FOUND);
    if (existing.status === 'disabled') {
      throw new AuthError(ErrorCode.ACCOUNT_DISABLED);
    }
    if (existing.status !== 'pending') {
      throw new AuthError(ErrorCode.EMAIL_ALREADY_REGISTERED);
    }

    const decision = await this.ratePolicy.evaluate(email, 'sign_up', now);
    if (!decision.allowed) {
      throw new AuthError(
        ErrorCode.RESEND_TOO_SOON,
        'A verification code was issued recently',
        decision.secondsRemaining,
      );
    }

    const prepared = this.issuer.prepare(existing.id, 'sign_up', now);

    await this.unitOfWork.withTransaction(async (ctx) => {
      const locked = await this.accounts.findByEmailForUpdate(ctx, email);
      if (!locked) throw new AuthError(ErrorCode.RESOURCE_NOT_FOUND);
      if (locked.status === 'disabled') {
        throw new AuthError(ErrorCode.ACCOUNT_DISABLED);
      }
      if (locked.status !== 'pending') {
        throw new AuthError(ErrorCode.EMAIL_ALREADY_REGISTERED);
      }
      await this.issuer.issue(ctx, {
        account: locked,
        purpose: 'sign_up',
        prepared,
        correlationId: command.correlationId,
        now,
      });
    });

    return {
      maskedEmail: maskEmail(existing.email),
      secondsRemaining: this.ratePolicy.nextAllowedSeconds(),
    };
  }

  /**
   * An unverified account may sign up again. Its credentials are replaced in
   * place, every live code dies, and the resend window still applies — this is
   * not a way to bypass the durable counter.
   */
  private async reissueForPending(
    existing: AccountEntity,
    command: SignUpCommand,
    email: string,
    language: EventLanguage,
    now: Date,
  ): Promise<SignUpResponseDto> {
    if (existing.status === 'disabled') {
      throw new AuthError(ErrorCode.ACCOUNT_DISABLED);
    }
    if (existing.status !== 'pending') {
      throw new AuthError(ErrorCode.EMAIL_ALREADY_REGISTERED);
    }

    const decision = await this.ratePolicy.evaluate(email, 'sign_up', now);
    if (!decision.allowed) {
      throw new AuthError(
        ErrorCode.RESEND_TOO_SOON,
        'A verification code was issued recently',
        decision.secondsRemaining,
      );
    }

    const passwordHash = await this.passwords.hash(command.password);
    const prepared = this.issuer.prepare(existing.id, 'sign_up', now);

    await this.unitOfWork.withTransaction(async (ctx) => {
      const locked = await this.accounts.findByEmailForUpdate(ctx, email);
      if (!locked) {
        throw new AuthError(ErrorCode.RESOURCE_NOT_FOUND);
      }
      if (locked.status === 'disabled') {
        throw new AuthError(ErrorCode.ACCOUNT_DISABLED);
      }
      if (locked.status !== 'pending') {
        throw new AuthError(ErrorCode.EMAIL_ALREADY_REGISTERED);
      }

      locked.language = language;
      locked.passwordHash = passwordHash;
      locked.passwordUpdatedAt = now;
      await this.accounts.update(ctx, locked);
      await this.issuer.issue(ctx, {
        account: locked,
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

  /**
   * Returns the error to raise *after* the transaction commits, or null when
   * the code matches. The attempt counter is the only write on the failure
   * path, and it must survive the rejected request (BR-05).
   */
  private async checkCode(
    ctx: TransactionContext,
    code: VerificationCodeEntity | null,
    submitted: string,
    now: Date,
  ): Promise<AuthError | null> {
    if (!code) {
      return new AuthError(ErrorCode.INVALID_VERIFICATION_CODE);
    }
    if (code.consumedAt !== null) {
      return new AuthError(ErrorCode.INVALID_VERIFICATION_CODE);
    }
    if (code.expiresAt.getTime() <= now.getTime()) {
      return new AuthError(ErrorCode.VERIFICATION_CODE_EXPIRED);
    }
    if (code.attempts >= code.maxAttempts) {
      return new AuthError(ErrorCode.VERIFICATION_CODE_ATTEMPTS_EXHAUSTED);
    }

    if (!verifyVerificationCode(submitted, code.codeSalt, code.codeHash)) {
      code.attempts = Math.min(code.attempts + 1, code.maxAttempts);
      await this.codes.update(ctx, code);
      return new AuthError(ErrorCode.INVALID_VERIFICATION_CODE);
    }
    return null;
  }

  private responseFor(account: AccountEntity): SignUpResponseDto {
    return {
      accountId: account.id,
      maskedEmail: maskEmail(account.email),
      language: account.language,
      resendAfterSeconds: this.ratePolicy.nextAllowedSeconds(),
    };
  }
}
