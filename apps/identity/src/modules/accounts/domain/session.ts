export interface CreateSessionProps {
  id: string;
  accountId: string;
  createdAt: Date;
  expiresAt: Date;
}

export interface RestoreSessionProps extends CreateSessionProps {
  lastUsedAt?: Date;
  revokedAt?: Date | null;
  revokedReason?: string | null;
  reuseDetectedAt?: Date | null;
}

/** A sign-in lifetime. Refresh rotation slides its expiry. */
export class Session {
  private constructor(
    readonly id: string,
    readonly accountId: string,
    readonly createdAt: Date,
    readonly lastUsedAt: Date,
    readonly expiresAt: Date,
    readonly revokedAt: Date | null,
    readonly revokedReason: string | null,
    readonly reuseDetectedAt: Date | null,
  ) {}

  static create(props: CreateSessionProps): Session {
    return new Session(
      props.id,
      props.accountId,
      props.createdAt,
      props.createdAt,
      props.expiresAt,
      null,
      null,
      null,
    );
  }

  static restore(props: RestoreSessionProps): Session {
    return new Session(
      props.id,
      props.accountId,
      props.createdAt,
      props.lastUsedAt ?? props.createdAt,
      props.expiresAt,
      props.revokedAt ?? null,
      props.revokedReason ?? null,
      props.reuseDetectedAt ?? null,
    );
  }

  isActive(now: Date = new Date()): boolean {
    return this.revokedAt === null && this.expiresAt.getTime() > now.getTime();
  }

  touch(at: Date, expiresAt: Date): Session {
    return new Session(
      this.id,
      this.accountId,
      this.createdAt,
      at,
      expiresAt,
      this.revokedAt,
      this.revokedReason,
      this.reuseDetectedAt,
    );
  }

  revoke(reason: string, at: Date = new Date()): Session {
    if (this.revokedAt) return this;
    return new Session(
      this.id,
      this.accountId,
      this.createdAt,
      this.lastUsedAt,
      this.expiresAt,
      at,
      reason,
      this.reuseDetectedAt,
    );
  }

  detectReuse(at: Date = new Date()): Session {
    return new Session(
      this.id,
      this.accountId,
      this.createdAt,
      this.lastUsedAt,
      this.expiresAt,
      this.revokedAt ?? at,
      this.revokedReason ?? 'refresh_reuse',
      this.reuseDetectedAt ?? at,
    );
  }
}
