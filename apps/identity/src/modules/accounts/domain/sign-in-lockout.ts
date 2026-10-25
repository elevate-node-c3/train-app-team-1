export const SIGN_IN_LOCK_THRESHOLD = 10;
export const SIGN_IN_LOCK_SECONDS = 15 * 60;

export interface SignInLockoutProps {
  email: string;
  failedCount: number;
  lockedUntil: Date | null;
  updatedAt: Date;
}

/**
 * Lockout state is keyed by normalized email, whether or not an account exists.
 * That is what makes "unknown address" and "wrong password" arrive at the same
 * counter instead of letting an attacker probe for accounts.
 */
export class SignInLockout {
  constructor(
    readonly email: string,
    readonly failedCount: number,
    readonly lockedUntil: Date | null,
    readonly updatedAt: Date,
  ) {}

  static empty(email: string, at: Date = new Date()): SignInLockout {
    return new SignInLockout(email, 0, null, at);
  }

  isLocked(now: Date = new Date()): boolean {
    return (
      this.lockedUntil !== null &&
      this.lockedUntil.getTime() > now.getTime()
    );
  }

  secondsRemaining(now: Date = new Date()): number {
    if (!this.lockedUntil) return 0;
    return Math.max(
      0,
      Math.ceil((this.lockedUntil.getTime() - now.getTime()) / 1000),
    );
  }

  recordFailure(
    now: Date = new Date(),
    threshold = SIGN_IN_LOCK_THRESHOLD,
    lockSeconds = SIGN_IN_LOCK_SECONDS,
  ): SignInLockout {
    if (this.isLocked(now)) return this;

    const failedCount = this.failedCount + 1;
    return new SignInLockout(
      this.email,
      failedCount,
      failedCount >= threshold
        ? new Date(now.getTime() + lockSeconds * 1000)
        : null,
      now,
    );
  }

  reset(now: Date = new Date()): SignInLockout {
    return new SignInLockout(this.email, 0, null, now);
  }
}
