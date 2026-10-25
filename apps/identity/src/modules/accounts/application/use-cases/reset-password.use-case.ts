import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  ErrorCode,
  passwordPolicyViolations,
  TOKEN_DEFAULTS,
  type ResetPasswordRequestDto,
  type ResetPasswordResponseDto,
} from '@app/contracts';
import type { TransactionContext } from '@app/common/persistence/unit-of-work.port.js';
import {
  UNIT_OF_WORK,
  type UnitOfWorkPort,
} from '@app/common/persistence/unit-of-work.port.js';
import {
  OUTBOX,
  type OutboxPort,
} from '@app/messaging/outbox/outbox.port.js';
import type { Account } from '../../domain/account.js';
import {
  buildPasswordReset,
  buildSessionRevoked,
} from '../../domain/events/identity-events.factory.js';
import { verifyVerificationCode } from '../../domain/verification-code.hashing.js';
import type { VerificationCode } from '../../domain/verification-code.js';
import { AuthError } from '../auth-error.js';
import {
  ACCOUNT_REPOSITORY,
  type AccountRepositoryPort,
} from '../ports/account.repository.port.js';
import {
  DEVICE_CREDENTIAL_REPOSITORY,
  type DeviceCredentialRepositoryPort,
} from '../ports/device-credential.repository.port.js';
import {
  PASSWORD_HASHER,
  type PasswordHasherPort,
} from '../ports/password-hasher.port.js';
import {
  REFRESH_TOKEN_REPOSITORY,
  type RefreshTokenRepositoryPort,
} from '../ports/refresh-token.repository.port.js';
import {
  SESSION_REPOSITORY,
  type SessionRepositoryPort,
} from '../ports/session.repository.port.js';
import {
  VERIFICATION_CODE_REPOSITORY,
  type VerificationCodeRepositoryPort,
} from '../ports/verification-code.repository.port.js';

export interface ResetPasswordCommand extends ResetPasswordRequestDto {
  correlationId: string;
}

type Outcome =
  | { failed: AuthError }
  | { account: Account; revokedSessionIds: string[] };

/**
 * Reset is one request: proving the code and setting the new password happen
 * together. The reset code is consumed, every session and refresh token is
 * revoked, and a single account-wide revocation marker is published so access
 * tokens minted before this instant stop working at the gateway.
 */
@Injectable()
export class ResetPasswordUseCase {
  constructor(
    @Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWorkPort,
    @Inject(ACCOUNT_REPOSITORY) private readonly accounts: AccountRepositoryPort,
    @Inject(VERIFICATION_CODE_REPOSITORY)
    private readonly codes: VerificationCodeRepositoryPort,
    @Inject(PASSWORD_HASHER) private readonly passwords: PasswordHasherPort,
    @Inject(SESSION_REPOSITORY)
    private readonly sessions: SessionRepositoryPort,
    @Inject(REFRESH_TOKEN_REPOSITORY)
    private readonly refreshTokens: RefreshTokenRepositoryPort,
    @Inject(DEVICE_CREDENTIAL_REPOSITORY)
    private readonly deviceCredentials: DeviceCredentialRepositoryPort,
    @Inject(OUTBOX) private readonly outbox: OutboxPort,
  ) {}

  async execute(
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
      async (ctx): Promise<Outcome> => {
        const account = await this.accounts.findByEmailForUpdate(ctx, email);
        if (!account) {
          return { failed: new AuthError(ErrorCode.PASSWORD_RESET_INVALID) };
        }
        if (account.isDisabled()) {
          return { failed: new AuthError(ErrorCode.ACCOUNT_DISABLED) };
        }

        const code = await this.codes.findLatestLive(
          ctx,
          account.id,
          'password_reset',
          { forUpdate: true },
        );
        const failure = await this.checkCode(
          ctx,
          code,
          command.code,
          now,
        );
        if (failure) return { failed: failure };

        if (
          account.passwordHash &&
          (await this.passwords.verify(command.newPassword, account.passwordHash))
        ) {
          return { failed: new AuthError(ErrorCode.PASSWORD_REUSE) };
        }

        await this.codes.update(ctx, code!.consume(now));
        const updated = account.changePassword(newHash, now);
        await this.accounts.update(ctx, updated);

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

        return { account: updated, revokedSessionIds };
      },
    );

    if ('failed' in outcome) throw outcome.failed;
    return { reset: true };
  }

  private async checkCode(
    ctx: TransactionContext,
    code: VerificationCode | null,
    submitted: string,
    now: Date,
  ): Promise<AuthError | null> {
    if (!code || code.isConsumed() || !code.hasAttemptsRemaining()) {
      return new AuthError(ErrorCode.PASSWORD_RESET_INVALID);
    }
    if (code.isExpired(now)) {
      return new AuthError(ErrorCode.PASSWORD_RESET_INVALID);
    }
    if (!verifyVerificationCode(submitted, code.codeSalt, code.codeHash)) {
      await this.codes.update(ctx, code.recordFailure());
      return new AuthError(ErrorCode.PASSWORD_RESET_INVALID);
    }
    return null;
  }
}
