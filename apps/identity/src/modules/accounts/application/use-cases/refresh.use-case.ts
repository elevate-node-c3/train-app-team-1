import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  ErrorCode,
  type RefreshResponseDto,
  type RefreshTokenRequestDto,
} from '@app/contracts';
import type { TransactionContext } from '@app/common/persistence/unit-of-work.port.js';
import {
  UNIT_OF_WORK,
  type UnitOfWorkPort,
} from '@app/common/persistence/unit-of-work.port.js';
import type { Session } from '../../domain/session.js';
import {
  OUTBOX,
  type OutboxPort,
} from '@app/messaging/outbox/outbox.port.js';
import { buildSessionRevoked } from '../../domain/events/identity-events.factory.js';
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
  REFRESH_TOKEN_REPOSITORY,
  type RefreshTokenRepositoryPort,
} from '../ports/refresh-token.repository.port.js';
import {
  REFRESH_TOKEN_HASHER,
  type RefreshTokenHasherPort,
} from '../ports/refresh-token-hasher.port.js';
import {
  SESSION_REPOSITORY,
  type SessionRepositoryPort,
} from '../ports/session.repository.port.js';
import { SessionIssuer } from '../services/session.issuer.js';

export interface RefreshCommand extends RefreshTokenRequestDto {
  correlationId: string;
}

type Outcome =
  | { failed: AuthError }
  | { tokens: RefreshResponseDto }
  | { reuseDetected: true };

/**
 * Rotation. The successor pair is sealed into the consumed row for ten seconds
 * so two requests that raced on the same token receive the same answer instead
 * of one of them being treated as theft. After the grace window, a reused
 * rotated token is theft and kills the whole session.
 */
@Injectable()
export class RefreshUseCase {
  constructor(
    @Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWorkPort,
    @Inject(ACCOUNT_REPOSITORY) private readonly accounts: AccountRepositoryPort,
    @Inject(SESSION_REPOSITORY)
    private readonly sessions: SessionRepositoryPort,
    @Inject(REFRESH_TOKEN_REPOSITORY)
    private readonly refreshTokens: RefreshTokenRepositoryPort,
    @Inject(DEVICE_CREDENTIAL_REPOSITORY)
    private readonly deviceCredentials: DeviceCredentialRepositoryPort,
    @Inject(REFRESH_TOKEN_HASHER)
    private readonly tokenHasher: RefreshTokenHasherPort,
    private readonly issuer: SessionIssuer,
    @Inject(OUTBOX) private readonly outbox: OutboxPort,
  ) {}

  async execute(command: RefreshCommand): Promise<RefreshResponseDto> {
    const now = new Date();
    const tokenHash = this.tokenHasher.hash(command.refreshToken);

    const outcome = await this.unitOfWork.withTransaction(
      async (ctx): Promise<Outcome> => {
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
        if (account.isDisabled()) {
          await this.revokeSession(ctx, session, 'admin', now);
          return { failed: new AuthError(ErrorCode.ACCOUNT_DISABLED) };
        }

        if (current.isActive(now)) {
          if (!session.isActive(now)) {
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

        if (current.graceIsOpen(now)) {
          const replayed = this.issuer.replay(current);
          return replayed
            ? { tokens: replayed }
            : { failed: new AuthError(ErrorCode.INVALID_REFRESH_TOKEN) };
        }

        if (current.status === 'revoked' || current.isExpired(now)) {
          return { failed: new AuthError(ErrorCode.INVALID_REFRESH_TOKEN) };
        }

        // A rotated token presented after the grace window: a replay or theft.
        const reused = session.detectReuse(now);
        await this.sessions.update(ctx, reused);
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

  private async revokeSession(
    ctx: TransactionContext,
    session: Session,
    reason: 'admin',
    now: Date,
  ): Promise<void> {
    await this.sessions.update(ctx, session.revoke(reason, now));
    await this.refreshTokens.revokeBySession(ctx, session.id, now);
    await this.deviceCredentials.revokeBySession(ctx, session.id, now);
  }
}
