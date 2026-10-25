import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { TokenPairDto } from '@app/contracts';
import type { TransactionContext } from '@app/common/persistence/unit-of-work.port.js';
import type { Account } from '../../domain/account.js';
import { RefreshToken } from '../../domain/refresh-token.js';
import { Session } from '../../domain/session.js';
import { accessLevelOf } from '../access-level.js';
import {
  TOKEN_SETTINGS,
  type TokenSettings,
} from '../token-settings.js';
import {
  ACCESS_TOKEN_SIGNER,
  type AccessTokenSignerPort,
} from '../ports/access-token-signer.port.js';
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

export interface IssuedTokens {
  tokens: TokenPairDto;
  session: Session;
  refreshToken: RefreshToken;
  accessExpiresAt: Date;
}

export interface IssuedSuccessor {
  tokens: TokenPairDto;
  refreshToken: RefreshToken;
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
    @Inject(SESSION_REPOSITORY)
    private readonly sessions: SessionRepositoryPort,
    @Inject(REFRESH_TOKEN_REPOSITORY)
    private readonly refreshTokens: RefreshTokenRepositoryPort,
    @Inject(REFRESH_TOKEN_HASHER)
    private readonly tokenHasher: RefreshTokenHasherPort,
    @Inject(ACCESS_TOKEN_SIGNER)
    private readonly signer: AccessTokenSignerPort,
    @Inject(TOKEN_SETTINGS)
    private readonly tokens: TokenSettings,
  ) {}

  async issue(
    ctx: TransactionContext,
    account: Account,
    now: Date,
  ): Promise<IssuedTokens> {
    const session = Session.create({
      id: randomUUID(),
      accountId: account.id,
      createdAt: now,
      expiresAt: new Date(now.getTime() + this.tokens.refreshTtlSeconds * 1000),
    });

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
    account: Account,
    session: Session,
    current: RefreshToken,
    now: Date,
  ): Promise<IssuedSuccessor> {
    const expiresAt = new Date(
      now.getTime() + this.tokens.refreshTtlSeconds * 1000,
    );
    const successor = await this.mintPair(
      account,
      session.id,
      now,
      expiresAt,
    );
    const graceExpiresAt = new Date(
      now.getTime() + this.tokens.refreshGraceSeconds * 1000,
    );

    await this.refreshTokens.update(
      ctx,
      current.markRotated(
        successor.refreshToken.id,
        now,
        this.tokenHasher.seal(successor.tokens),
        graceExpiresAt,
      ),
    );
    await this.refreshTokens.save(ctx, successor.refreshToken);
    await this.sessions.update(ctx, session.touch(now, expiresAt));

    return {
      tokens: successor.tokens,
      refreshToken: successor.refreshToken,
      accessExpiresAt: successor.accessExpiresAt,
    };
  }

  /** Replays the sealed successor pair during the 10-second grace window. */
  replay(current: RefreshToken): TokenPairDto | null {
    if (!current.gracePayload) return null;
    return this.tokenHasher.open<TokenPairDto>(current.gracePayload);
  }

  private async mintPair(
    account: Account,
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
    const refreshToken = RefreshToken.issue({
      id: randomUUID(),
      sessionId,
      tokenHash: this.tokenHasher.hash(refreshPlaintext),
      issuedAt: now,
      expiresAt: refreshExpiresAt,
    });

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
