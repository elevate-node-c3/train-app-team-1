import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  ErrorCode,
  type RefreshResponseDto,
  type RefreshTokenRequestDto,
  type SignInRequestDto,
  type SignInResponseDto,
  type SignOutRequestDto,
  type SignOutResponseDto,
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
import type { AccountEntity } from '../entities/account.entity.js';
import type { RefreshTokenEntity } from '../entities/refresh-token.entity.js';
import { SignInLockoutEntity } from '../entities/sign-in-lockout.entity.js';
import type { SessionEntity } from '../entities/session.entity.js';
import { buildSessionRevoked } from '../identity-events.factory.js';
import { NodeRefreshTokenHasher } from '../node-refresh-token.hasher.js';
import { AccountRepository } from '../repositories/account.repository.js';
import { DeviceCredentialRepository } from '../repositories/device-credential.repository.js';
import { RefreshTokenRepository } from '../repositories/refresh-token.repository.js';
import { SessionRepository } from '../repositories/session.repository.js';
import { SignInLockoutRepository } from '../repositories/sign-in-lockout.repository.js';
import { SessionIssuer, type IssuedTokens } from '../session.issuer.js';
import { VerificationRatePolicy } from '../verification-rate.policy.js';

export const SIGN_IN_LOCK_THRESHOLD = 10;
export const SIGN_IN_LOCK_SECONDS = 15 * 60;

export interface SignInCommand extends SignInRequestDto {
  correlationId: string;
}

export interface RefreshCommand extends RefreshTokenRequestDto {
  correlationId: string;
}

export interface SignOutCommand extends SignOutRequestDto {
  /** Restored from the verified gateway caller, never from the body. */
  accountId: string;
  correlationId: string;
}

type SignInOutcome =
  | { failed: AuthError }
  | { account: AccountEntity; issued: IssuedTokens }
  | { account: AccountEntity; verification: true };

type RefreshOutcome =
  | { failed: AuthError }
  | { tokens: RefreshResponseDto }
  | { reuseDetected: true };

function emptyLockout(email: string, at: Date): SignInLockoutEntity {
  const lockout = new SignInLockoutEntity();
  lockout.email = email;
  lockout.failedCount = 0;
  lockout.lockedUntil = null;
  lockout.updatedAt = at;
  return lockout;
}

function isLocked(lockout: SignInLockoutEntity, now: Date): boolean {
  return (
    lockout.lockedUntil !== null &&
    lockout.lockedUntil.getTime() > now.getTime()
  );
}

function secondsRemaining(lockout: SignInLockoutEntity, now: Date): number {
  if (!lockout.lockedUntil) return 0;
  return Math.max(
    0,
    Math.ceil((lockout.lockedUntil.getTime() - now.getTime()) / 1000),
  );
}

function recordLockoutFailure(lockout: SignInLockoutEntity, now: Date): void {
  if (isLocked(lockout, now)) return;

  const failedCount = lockout.failedCount + 1;
  lockout.failedCount = failedCount;
  lockout.lockedUntil =
    failedCount >= SIGN_IN_LOCK_THRESHOLD
      ? new Date(now.getTime() + SIGN_IN_LOCK_SECONDS * 1000)
      : null;
  lockout.updatedAt = now;
}

function resetLockout(lockout: SignInLockoutEntity, now: Date): void {
  lockout.failedCount = 0;
  lockout.lockedUntil = null;
  lockout.updatedAt = now;
}

function sessionIsActive(session: SessionEntity, now: Date): boolean {
  return (
    session.revokedAt === null && session.expiresAt.getTime() > now.getTime()
  );
}

function detectSessionReuse(session: SessionEntity, at: Date): void {
  session.revokedAt ??= at;
  session.revokedReason ??= 'refresh_reuse';
  session.reuseDetectedAt ??= at;
}

function refreshTokenIsActive(token: RefreshTokenEntity, now: Date): boolean {
  return token.status === 'active' && token.expiresAt.getTime() > now.getTime();
}

function refreshTokenIsExpired(token: RefreshTokenEntity, now: Date): boolean {
  return token.expiresAt.getTime() <= now.getTime();
}

function refreshTokenGraceIsOpen(
  token: RefreshTokenEntity,
  now: Date,
): boolean {
  return (
    token.status === 'rotated' &&
    token.gracePayload !== null &&
    token.graceExpiresAt !== null &&
    token.graceExpiresAt.getTime() > now.getTime()
  );
}

/**
 * Sign-in deliberately does the password comparison while holding the account
 * and lockout rows. That is slower than a read-only check, but it is the only
 * shape in which two concurrent wrong passwords cannot both read `9`.
 *
 * An unknown address takes the same bcrypt path against a dummy hash, so the
 * response time does not answer "does this account exist?".
 */
@Injectable()
export class SessionsService {
  private dummyHash: Promise<string> | null = null;

  constructor(
    @Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWorkPort,
    private readonly accounts: AccountRepository,
    private readonly passwords: BcryptPasswordHasher,
    private readonly lockouts: SignInLockoutRepository,
    private readonly sessions: SessionRepository,
    private readonly refreshTokens: RefreshTokenRepository,
    private readonly deviceCredentials: DeviceCredentialRepository,
    private readonly tokenHasher: NodeRefreshTokenHasher,
    private readonly issuer: SessionIssuer,
    private readonly ratePolicy: VerificationRatePolicy,
    @Inject(OUTBOX) private readonly outbox: OutboxPort,
  ) {}

  async signIn(command: SignInCommand): Promise<SignInResponseDto> {
    const now = new Date();
    const email = command.email.trim().toLowerCase();
    const existingLockout = await this.lockouts.find(email);
    if (existingLockout && isLocked(existingLockout, now)) {
      throw new AuthError(
        ErrorCode.ACCOUNT_LOCKED,
        'Too many failed sign-in attempts',
        secondsRemaining(existingLockout, now),
      );
    }

    const outcome = await this.unitOfWork.withTransaction(
      async (ctx): Promise<SignInOutcome> => {
        const account = await this.accounts.findByEmailForUpdate(ctx, email);
        const lockout =
          (await this.lockouts.findForUpdate(ctx, email)) ??
          emptyLockout(email, now);

        const passwordMatches = await this.checkPassword(
          account,
          command.password,
        );
        if (!passwordMatches) {
          return this.recordFailure(ctx, lockout, now);
        }

        // Correct password, but the account may still be unusable. The
        // password check happens first so a wrong password never reveals that
        // an address exists and is disabled.
        if (!account) {
          return { failed: new AuthError(ErrorCode.INVALID_CREDENTIALS) };
        }
        if (account.status === 'disabled') {
          return { failed: new AuthError(ErrorCode.ACCOUNT_DISABLED) };
        }

        resetLockout(lockout, now);
        await this.lockouts.save(ctx, lockout);

        if (account.emailVerifiedAt === null) {
          return { account, verification: true };
        }

        const issued = await this.issuer.issue(ctx, account, now);
        return { account, issued };
      },
    );

    if ('failed' in outcome) throw outcome.failed;

    const maskedEmail = maskEmail(outcome.account.email);
    if ('verification' in outcome) {
      const decision = await this.ratePolicy.evaluate(
        outcome.account.email,
        'sign_up',
        now,
      );
      return {
        verificationRequired: true,
        maskedEmail,
        secondsRemaining: decision.allowed ? 0 : decision.secondsRemaining,
        tokens: null,
      };
    }

    return {
      verificationRequired: false,
      maskedEmail,
      secondsRemaining: 0,
      tokens: outcome.issued.tokens,
    };
  }

  async refresh(command: RefreshCommand): Promise<RefreshResponseDto> {
    const now = new Date();
    const tokenHash = this.tokenHasher.hash(command.refreshToken);

    const outcome = await this.unitOfWork.withTransaction(
      async (ctx): Promise<RefreshOutcome> => {
        const current = await this.refreshTokens.findByHashForUpdate(
          ctx,
          tokenHash,
        );
        if (!current) {
          return { failed: new AuthError(ErrorCode.INVALID_REFRESH_TOKEN) };
        }

        const session = await this.sessions.findByIdForUpdate(
          ctx,
          current.sessionId,
        );
        if (!session || session.revokedAt !== null) {
          return { failed: new AuthError(ErrorCode.SESSION_REVOKED) };
        }

        const account = await this.accounts.findById(session.accountId);
        if (!account) {
          return { failed: new AuthError(ErrorCode.INVALID_REFRESH_TOKEN) };
        }
        if (account.status === 'disabled') {
          await this.revokeSession(ctx, session, 'admin', now);
          return { failed: new AuthError(ErrorCode.ACCOUNT_DISABLED) };
        }

        if (refreshTokenIsActive(current, now)) {
          if (!sessionIsActive(session, now)) {
            return { failed: new AuthError(ErrorCode.SESSION_REVOKED) };
          }
          const rotated = await this.issuer.rotate(
            ctx,
            account,
            session,
            current,
            now,
          );
          return { tokens: rotated.tokens };
        }

        if (refreshTokenGraceIsOpen(current, now)) {
          const replayed = this.issuer.replay(current);
          return replayed
            ? { tokens: replayed }
            : { failed: new AuthError(ErrorCode.INVALID_REFRESH_TOKEN) };
        }

        if (
          current.status === 'revoked' ||
          refreshTokenIsExpired(current, now)
        ) {
          return { failed: new AuthError(ErrorCode.INVALID_REFRESH_TOKEN) };
        }

        // A rotated token presented after the grace window: a replay or theft.
        detectSessionReuse(session, now);
        await this.sessions.update(ctx, session);
        await this.refreshTokens.revokeBySession(ctx, session.id, now);
        await this.deviceCredentials.revokeBySession(ctx, session.id, now);
        await this.outbox.append(
          ctx,
          buildSessionRevoked({
            eventId: randomUUID(),
            correlationId: command.correlationId,
            occurredAt: now,
            accountId: account.id,
            sessionId: session.id,
            jti: '',
            expiresAt: session.expiresAt,
            reason: 'refresh_reuse',
          }),
        );
        return { reuseDetected: true };
      },
    );

    if ('failed' in outcome) throw outcome.failed;
    if ('reuseDetected' in outcome) {
      throw new AuthError(ErrorCode.REFRESH_TOKEN_REUSE_DETECTED);
    }
    return outcome.tokens;
  }

  async signOut(command: SignOutCommand): Promise<SignOutResponseDto> {
    const now = new Date();
    const tokenHash = this.tokenHasher.hash(command.refreshToken);

    await this.unitOfWork.withTransaction(async (ctx) => {
      const session = await this.sessions.findByIdForUpdate(
        ctx,
        command.sessionId,
      );
      if (!session || session.accountId !== command.accountId) {
        return;
      }

      if (session.revokedAt === null) {
        session.revokedAt = now;
        session.revokedReason = 'sign_out';
        await this.sessions.update(ctx, session);
      }
      await this.refreshTokens.revokeBySession(ctx, session.id, now);

      const token = await this.refreshTokens.findByHashForUpdate(
        ctx,
        tokenHash,
      );
      if (
        token &&
        token.sessionId === session.id &&
        token.status !== 'revoked'
      ) {
        token.status = 'revoked';
        token.revokedAt = now;
        await this.refreshTokens.update(ctx, token);
      }

      await this.deviceCredentials.revokeBySession(ctx, session.id, now);

      await this.outbox.append(
        ctx,
        buildSessionRevoked({
          eventId: randomUUID(),
          correlationId: command.correlationId,
          occurredAt: now,
          accountId: session.accountId,
          sessionId: session.id,
          jti: command.jti,
          expiresAt: new Date(command.accessTokenExpiresAt),
          reason: 'sign_out',
        }),
      );
    });

    return { revoked: true };
  }

  private async checkPassword(
    account: AccountEntity | null,
    submitted: string,
  ): Promise<boolean> {
    if (account?.passwordHash) {
      return this.passwords.verify(submitted, account.passwordHash);
    }
    const dummy = await this.dummyHashForTiming();
    await this.passwords.verify(submitted, dummy);
    return false;
  }

  private async recordFailure(
    ctx: TransactionContext,
    lockout: SignInLockoutEntity,
    now: Date,
  ): Promise<SignInOutcome> {
    recordLockoutFailure(lockout, now);
    await this.lockouts.save(ctx, lockout);
    if (isLocked(lockout, now)) {
      return {
        failed: new AuthError(
          ErrorCode.ACCOUNT_LOCKED,
          'Too many failed sign-in attempts',
          secondsRemaining(lockout, now),
        ),
      };
    }
    return { failed: new AuthError(ErrorCode.INVALID_CREDENTIALS) };
  }

  private async revokeSession(
    ctx: TransactionContext,
    session: SessionEntity,
    reason: 'admin',
    now: Date,
  ): Promise<void> {
    session.revokedAt ??= now;
    session.revokedReason ??= reason;
    await this.sessions.update(ctx, session);
    await this.refreshTokens.revokeBySession(ctx, session.id, now);
    await this.deviceCredentials.revokeBySession(ctx, session.id, now);
  }

  private dummyHashForTiming(): Promise<string> {
    this.dummyHash ??= this.passwords.hash(
      'train-app-not-a-real-account-password',
    );
    return this.dummyHash;
  }
}
