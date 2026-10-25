import type { VerificationCodePurpose } from '@app/contracts';
import {
  generateVerificationCodeSalt,
  hashVerificationCode,
} from './verification-code.hashing.js';

/** Enforced in the domain as well as in Joi: the invariant is not config-only. */
export const MAX_VERIFICATION_CODE_TTL_SECONDS = 600;
export const MAX_VERIFICATION_CODE_ATTEMPTS = 5;

export interface IssueVerificationCodeProps {
  id: string;
  accountId: string;
  purpose: VerificationCodePurpose;
  /** Plaintext. It is hashed immediately and never stored on the instance. */
  code: string;
  ttlSeconds: number;
  /**
   * Omitted in production so the timestamp is stamped *after* scrypt runs —
   * hashing is outside the BR-03 measurement, the response time includes it.
   */
  issuedAt?: Date;
  salt?: string;
  attempts?: number;
  maxAttempts?: number;
  consumedAt?: Date | null;
}

/**
 * A verification code aggregate. Only the hash and salt are persisted; the
 * plaintext leaves the process once, inside the event payload.
 */
export class VerificationCode {
  private constructor(
    readonly id: string,
    readonly accountId: string,
    readonly purpose: VerificationCodePurpose,
    readonly codeHash: string,
    readonly codeSalt: string,
    readonly issuedAt: Date,
    readonly expiresAt: Date,
    readonly consumedAt: Date | null,
    readonly attempts: number,
    readonly maxAttempts: number,
  ) {}

  static issue(props: IssueVerificationCodeProps): VerificationCode {
    if (
      !Number.isInteger(props.ttlSeconds) ||
      props.ttlSeconds < 1 ||
      props.ttlSeconds > MAX_VERIFICATION_CODE_TTL_SECONDS
    ) {
      throw new Error(
        `Verification code TTL must be between 1 and ${MAX_VERIFICATION_CODE_TTL_SECONDS} seconds`,
      );
    }

    const salt = props.salt ?? generateVerificationCodeSalt();
    // Deliberately before the timestamp: scrypt is not part of the delivery
    // budget, it is part of the sign-up response.
    const codeHash = hashVerificationCode(props.code, salt);
    const issuedAt = props.issuedAt ?? new Date();
    const expiresAt = new Date(
      issuedAt.getTime() + props.ttlSeconds * 1000,
    );

    return new VerificationCode(
      props.id,
      props.accountId,
      props.purpose,
      codeHash,
      salt,
      issuedAt,
      expiresAt,
      props.consumedAt ?? null,
      props.attempts ?? 0,
      props.maxAttempts ?? MAX_VERIFICATION_CODE_ATTEMPTS,
    );
  }

  static restore(props: {
    id: string;
    accountId: string;
    purpose: VerificationCodePurpose;
    codeHash: string;
    codeSalt: string;
    issuedAt: Date;
    expiresAt: Date;
    consumedAt?: Date | null;
    attempts?: number;
    maxAttempts?: number;
  }): VerificationCode {
    return new VerificationCode(
      props.id,
      props.accountId,
      props.purpose,
      props.codeHash,
      props.codeSalt,
      props.issuedAt,
      props.expiresAt,
      props.consumedAt ?? null,
      props.attempts ?? 0,
      props.maxAttempts ?? MAX_VERIFICATION_CODE_ATTEMPTS,
    );
  }

  isExpired(now: Date = new Date()): boolean {
    return this.expiresAt.getTime() <= now.getTime();
  }

  isConsumed(): boolean {
    return this.consumedAt !== null;
  }

  hasAttemptsRemaining(): boolean {
    return this.attempts < this.maxAttempts;
  }

  isUsable(now: Date = new Date()): boolean {
    return !this.isConsumed() && !this.isExpired(now) && this.hasAttemptsRemaining();
  }

  recordFailure(): VerificationCode {
    return new VerificationCode(
      this.id,
      this.accountId,
      this.purpose,
      this.codeHash,
      this.codeSalt,
      this.issuedAt,
      this.expiresAt,
      this.consumedAt,
      Math.min(this.attempts + 1, this.maxAttempts),
      this.maxAttempts,
    );
  }

  consume(at: Date = new Date()): VerificationCode {
    return new VerificationCode(
      this.id,
      this.accountId,
      this.purpose,
      this.codeHash,
      this.codeSalt,
      this.issuedAt,
      this.expiresAt,
      at,
      this.attempts,
      this.maxAttempts,
    );
  }
}
