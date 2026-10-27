import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { TokenPairDto } from '@app/contracts';
import type { TransactionContext } from '@app/common/persistence/unit-of-work.port.js';
import { accessLevelOf } from './access-level.js';
import type { AccountEntity } from './entities/account.entity.js';
import { RefreshTokenEntity } from './entities/refresh-token.entity.js';
import { SessionEntity } from './entities/session.entity.js';
import { IdentityJwtSigner } from './identity-jwt.signer.js';
import { NodeRefreshTokenHasher } from './node-refresh-token.hasher.js';
import { RefreshTokenRepository } from './repositories/refresh-token.repository.js';
import { SessionRepository } from './repositories/session.repository.js';
import { TOKEN_SETTINGS, type TokenSettings } from './token-settings.js';

export interface IssuedTokens {
  tokens: TokenPairDto;
  session: SessionEntity;
  refreshToken: RefreshTokenEntity;
  accessExpiresAt: Date;
}

export interface IssuedSuccessor {
  tokens: TokenPairDto;
  refreshToken: RefreshTokenEntity;
  accessExpiresAt: Date;
}

/**
 * Mints a token pair and writes the session/refresh rows in the caller's
 * transaction. Keeping signing here means every flow (verify, sign-in, refresh)
 * produces exactly the same claim set.
 */
@Injectable()
export class SessionIssuer {
  constructor(
    private readonly sessions: SessionRepository,
    private readonly refreshTokens: RefreshTokenRepository,
    private readonly tokenHasher: NodeRefreshTokenHasher,
    private readonly signer: IdentityJwtSigner,
    @Inject(TOKEN_SETTINGS)
    private readonly tokens: TokenSettings,
  ) {}

  async issue(
    ctx: TransactionContext,
    account: AccountEntity,
    now: Date,
  ): Promise<IssuedTokens> {
    const session = new SessionEntity();
    session.id = randomUUID();
    session.accountId = account.id;
    session.createdAt = now;
    session.lastUsedAt = now;
    session.expiresAt = new Date(
      now.getTime() + this.tokens.refreshTtlSeconds * 1000,
    );
    session.revokedAt = null;
    session.revokedReason = null;
    session.reuseDetectedAt = null;

    const issued = await this.mintPair(
      account,
      session.id,
      now,
      session.expiresAt,
    );
    await this.sessions.save(ctx, session);
    await this.refreshTokens.save(ctx, issued.refreshToken);

    return {
      tokens: issued.tokens,
      session,
      refreshToken: issued.refreshToken,
      accessExpiresAt: issued.accessExpiresAt,
    };
  }

  /**
   * Rotation. The old row is marked rotated before the successor is inserted:
   * the partial unique index allows one active token per session, so the order
   * is load-bearing rather than stylistic.
   */
  async rotate(
    ctx: TransactionContext,
    account: AccountEntity,
    session: SessionEntity,
    current: RefreshTokenEntity,
    now: Date,
  ): Promise<IssuedSuccessor> {
    const expiresAt = new Date(
      now.getTime() + this.tokens.refreshTtlSeconds * 1000,
    );
    const successor = await this.mintPair(account, session.id, now, expiresAt);
    const graceExpiresAt = new Date(
      now.getTime() + this.tokens.refreshGraceSeconds * 1000,
    );

    current.status = 'rotated';
    current.rotatedAt = now;
    current.replacedById = successor.refreshToken.id;
    current.gracePayload = this.tokenHasher.seal(successor.tokens);
    current.graceExpiresAt = graceExpiresAt;
    await this.refreshTokens.update(ctx, current);

    await this.refreshTokens.save(ctx, successor.refreshToken);
    session.lastUsedAt = now;
    session.expiresAt = expiresAt;
    await this.sessions.update(ctx, session);

    return {
      tokens: successor.tokens,
      refreshToken: successor.refreshToken,
      accessExpiresAt: successor.accessExpiresAt,
    };
  }

  /** Replays the sealed successor pair during the 10-second grace window. */
  replay(current: RefreshTokenEntity): TokenPairDto | null {
    if (!current.gracePayload) return null;
    return this.tokenHasher.open<TokenPairDto>(current.gracePayload);
  }

  private async mintPair(
    account: AccountEntity,
    sessionId: string,
    now: Date,
    refreshExpiresAt: Date,
  ): Promise<IssuedSuccessor> {
    const access = await this.signer.sign({
      accountId: account.id,
      level: accessLevelOf(account),
      roles: [...account.roles],
      sessionId,
      bookable: account.bookable,
      now,
    });
    const refreshPlaintext = this.tokenHasher.generate();
    const refreshToken = new RefreshTokenEntity();
    refreshToken.id = randomUUID();
    refreshToken.sessionId = sessionId;
    refreshToken.tokenHash = this.tokenHasher.hash(refreshPlaintext);
    refreshToken.status = 'active';
    refreshToken.issuedAt = now;
    refreshToken.expiresAt = refreshExpiresAt;
    refreshToken.rotatedAt = null;
    refreshToken.replacedById = null;
    refreshToken.gracePayload = null;
    refreshToken.graceExpiresAt = null;
    refreshToken.revokedAt = null;

    return {
      tokens: {
        accessToken: access.token,
        refreshToken: refreshPlaintext,
        tokenType: 'Bearer',
        accessExpiresIn: this.signer.accessTtlSeconds,
        refreshExpiresIn: Math.max(
          1,
          Math.floor((refreshExpiresAt.getTime() - now.getTime()) / 1000),
        ),
      },
      refreshToken,
      accessExpiresAt: access.expiresAt,
    };
  }
}
