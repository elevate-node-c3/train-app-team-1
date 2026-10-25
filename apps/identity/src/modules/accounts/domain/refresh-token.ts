export type RefreshTokenStatus = 'active' | 'rotated' | 'revoked';

export interface IssueRefreshTokenProps {
  id: string;
  sessionId: string;
  tokenHash: string;
  issuedAt: Date;
  expiresAt: Date;
}

export interface RestoreRefreshTokenProps extends IssueRefreshTokenProps {
  status: RefreshTokenStatus;
  rotatedAt?: Date | null;
  replacedById?: string | null;
  gracePayload?: string | null;
  graceExpiresAt?: Date | null;
  revokedAt?: Date | null;
}

/**
 * A refresh token row stores only a hash. The successor pair is kept encrypted
 * for the grace window, never as a usable plaintext token in the table.
 */
export class RefreshToken {
  private constructor(
    readonly id: string,
    readonly sessionId: string,
    readonly tokenHash: string,
    readonly status: RefreshTokenStatus,
    readonly issuedAt: Date,
    readonly expiresAt: Date,
    readonly rotatedAt: Date | null,
    readonly replacedById: string | null,
    readonly gracePayload: string | null,
    readonly graceExpiresAt: Date | null,
    readonly revokedAt: Date | null,
  ) {}

  static issue(props: IssueRefreshTokenProps): RefreshToken {
    return new RefreshToken(
      props.id,
      props.sessionId,
      props.tokenHash,
      'active',
      props.issuedAt,
      props.expiresAt,
      null,
      null,
      null,
      null,
      null,
    );
  }

  static restore(props: RestoreRefreshTokenProps): RefreshToken {
    return new RefreshToken(
      props.id,
      props.sessionId,
      props.tokenHash,
      props.status,
      props.issuedAt,
      props.expiresAt,
      props.rotatedAt ?? null,
      props.replacedById ?? null,
      props.gracePayload ?? null,
      props.graceExpiresAt ?? null,
      props.revokedAt ?? null,
    );
  }

  isActive(now: Date = new Date()): boolean {
    return (
      this.status === 'active' && this.expiresAt.getTime() > now.getTime()
    );
  }

  isExpired(now: Date = new Date()): boolean {
    return this.expiresAt.getTime() <= now.getTime();
  }

  markRotated(
    replacedById: string,
    at: Date,
    gracePayload: string,
    graceExpiresAt: Date,
  ): RefreshToken {
    return new RefreshToken(
      this.id,
      this.sessionId,
      this.tokenHash,
      'rotated',
      this.issuedAt,
      this.expiresAt,
      at,
      replacedById,
      gracePayload,
      graceExpiresAt,
      this.revokedAt,
    );
  }

  markRevoked(at: Date = new Date()): RefreshToken {
    return new RefreshToken(
      this.id,
      this.sessionId,
      this.tokenHash,
      'revoked',
      this.issuedAt,
      this.expiresAt,
      this.rotatedAt,
      this.replacedById,
      this.gracePayload,
      this.graceExpiresAt,
      at,
    );
  }

  graceIsOpen(now: Date = new Date()): boolean {
    return (
      this.status === 'rotated' &&
      this.gracePayload !== null &&
      this.graceExpiresAt !== null &&
      this.graceExpiresAt.getTime() > now.getTime()
    );
  }
}
