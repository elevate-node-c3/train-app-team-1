import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  ErrorCode,
  TOKEN_DEFAULTS,
  passwordPolicyViolations,
  type ForgotPasswordRequestDto,
  type ForgotPasswordResponseDto,
  type ResetPasswordRequestDto,
  type ResetPasswordResponseDto,
} from '@app/contracts';
import type { TransactionContext } from '@app/common/persistence/unit-of-work.port.js';
import {
  UNIT_OF_WORK,
  type UnitOfWorkPort,
} from '@app/common/persistence/unit-of-work.port.js';
import { OUTBOX, type OutboxPort } from '@app/messaging/outbox/outbox.port.js';
import { AuthError } from '../auth-error.js';
import { BcryptPasswordHasher } from '../bcrypt-password.hasher.js';
import type { AccountEntity } from '../entities/account.entity.js';
import type { VerificationCodeEntity } from '../entities/verification-code.entity.js';
import {
  buildPasswordReset,
  buildSessionRevoked,
} from '../identity-events.factory.js';
import { AccountRepository } from '../repositories/account.repository.js';
import { DeviceCredentialRepository } from '../repositories/device-credential.repository.js';
import { RefreshTokenRepository } from '../repositories/refresh-token.repository.js';
import { SessionRepository } from '../repositories/session.repository.js';
import { VerificationCodeRepository } from '../repositories/verification-code.repository.js';
import { verifyVerificationCode } from '../verification-code.hashing.js';
import { VerificationCodeIssuer } from '../verification-code.issuer.js';
import { VerificationRatePolicy } from '../verification-rate.policy.js';

export interface ForgotPasswordCommand extends ForgotPasswordRequestDto {
  correlationId: string;
}

export interface ResetPasswordCommand extends ResetPasswordRequestDto {
  correlationId: string;
}

type ResetOutcome =
  | { failed: AuthError }
  | { account: AccountEntity; revokedSessionIds: string[] };

/**
 * BR-09: the answer must not reveal whether the address exists. Every address
 * gets the same status, the same interval, and the same body. Only an address
 * with an account also gets a mail and an outbox row.
 */
@Injectable()
export class PasswordsService {
  constructor(
    @Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWorkPort,
    private readonly accounts: AccountRepository,
    private readonly codes: VerificationCodeRepository,
    private readonly passwords: BcryptPasswordHasher,
    private readonly sessions: SessionRepository,
    private readonly refreshTokens: RefreshTokenRepository,
    private readonly deviceCredentials: DeviceCredentialRepository,
    private readonly issuer: VerificationCodeIssuer,
    private readonly ratePolicy: VerificationRatePolicy,
    @Inject(OUTBOX) private readonly outbox: OutboxPort,
  ) {}

  async forgotPassword(
    command: ForgotPasswordCommand,
  ): Promise<ForgotPasswordResponseDto> {
    const now = new Date();
    const email = command.email.trim().toLowerCase();
    const decision = await this.ratePolicy.evaluate(
      email,
      'password_reset',
      now,
    );
    if (!decision.allowed) {
      return { secondsRemaining: decision.secondsRemaining };
    }

    const account = await this.accounts.findByEmail(email);
    const eligible = account && account.status !== 'disabled';
    const prepared = eligible
      ? this.issuer.prepare(account.id, 'password_reset', now)
      : null;

    await this.unitOfWork.withTransaction(async (ctx) => {
      if (!account) {
        // The counter exists even for an unknown address; that is what keeps
        // the sixth request as slow as the first.
        await this.issuer.recordRequest(ctx, {
          email,
          accountId: null,
          purpose: 'password_reset',
          now,
        });
        return;
      }

      const locked = await this.accounts.findByEmailForUpdate(ctx, email);
      if (!locked || locked.status === 'disabled' || !prepared) {
        await this.issuer.recordRequest(ctx, {
          email,
          accountId: account.id,
          purpose: 'password_reset',
          now,
        });
        return;
      }

      await this.issuer.issue(ctx, {
        account: locked,
        purpose: 'password_reset',
        prepared,
        correlationId: command.correlationId,
        now,
      });
    });

    return { secondsRemaining: this.ratePolicy.nextAllowedSeconds() };
  }

  async resetPassword(
    command: ResetPasswordCommand,
  ): Promise<ResetPasswordResponseDto> {
    const policy = passwordPolicyViolations(command.newPassword);
    if (policy.length > 0) {
      throw new AuthError(
        ErrorCode.VALIDATION_ERROR,
        policy.map((violation) => violation.message).join('; '),
      );
    }

    const now = new Date();
    const email = command.email.trim().toLowerCase();
    // Hash before the transaction; bcrypt is a deliberate part of latency but
    // not of the row-lock lifetime.
    const newHash = await this.passwords.hash(command.newPassword);

    const outcome = await this.unitOfWork.withTransaction(
      async (ctx): Promise<ResetOutcome> => {
        const account = await this.accounts.findByEmailForUpdate(ctx, email);
        if (!account) {
          return { failed: new AuthError(ErrorCode.PASSWORD_RESET_INVALID) };
        }
        if (account.status === 'disabled') {
          return { failed: new AuthError(ErrorCode.ACCOUNT_DISABLED) };
        }

        const code = await this.codes.findLatestLive(
          ctx,
          account.id,
          'password_reset',
          { forUpdate: true },
        );
        const failure = await this.checkCode(ctx, code, command.code, now);
        if (failure) return { failed: failure };

        if (
          account.passwordHash &&
          (await this.passwords.verify(
            command.newPassword,
            account.passwordHash,
          ))
        ) {
          return { failed: new AuthError(ErrorCode.PASSWORD_REUSE) };
        }

        code!.consumedAt = now;
        await this.codes.update(ctx, code!);

        account.passwordHash = newHash;
        account.passwordUpdatedAt = now;
        await this.accounts.update(ctx, account);

        const revokedSessionIds = await this.sessions.revokeByAccount(
          ctx,
          account.id,
          'password_reset',
          now,
        );
        await this.refreshTokens.revokeByAccount(ctx, account.id, now);
        await this.deviceCredentials.revokeByAccount(ctx, account.id, now);

        await this.outbox.append(
          ctx,
          buildPasswordReset({
            eventId: randomUUID(),
            correlationId: command.correlationId,
            occurredAt: now,
            accountId: account.id,
          }),
        );
        await this.outbox.append(
          ctx,
          buildSessionRevoked({
            eventId: randomUUID(),
            correlationId: command.correlationId,
            occurredAt: now,
            accountId: account.id,
            sessionId: revokedSessionIds[0] ?? '',
            jti: '',
            // Access tokens are short-lived; the account marker need not
            // outlive the longest one that could already exist.
            expiresAt: new Date(
              now.getTime() + TOKEN_DEFAULTS.accessTtlSeconds * 1000,
            ),
            reason: 'password_reset',
            allSessions: true,
          }),
        );

        return { account, revokedSessionIds };
      },
    );

    if ('failed' in outcome) throw outcome.failed;
    return { reset: true };
  }

  private async checkCode(
    ctx: TransactionContext,
    code: VerificationCodeEntity | null,
    submitted: string,
    now: Date,
  ): Promise<AuthError | null> {
    if (
      !code ||
      code.consumedAt !== null ||
      code.attempts >= code.maxAttempts
    ) {
      return new AuthError(ErrorCode.PASSWORD_RESET_INVALID);
    }
    if (code.expiresAt.getTime() <= now.getTime()) {
      return new AuthError(ErrorCode.PASSWORD_RESET_INVALID);
    }
    if (!verifyVerificationCode(submitted, code.codeSalt, code.codeHash)) {
      code.attempts = Math.min(code.attempts + 1, code.maxAttempts);
      await this.codes.update(ctx, code);
      return new AuthError(ErrorCode.PASSWORD_RESET_INVALID);
    }
    return null;
  }
}
