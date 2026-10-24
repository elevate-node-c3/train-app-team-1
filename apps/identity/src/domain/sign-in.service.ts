import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import { DomainException } from '@app/common';
import { ErrorCode, IdentityEventType, SESSION_SERVICE } from '@app/contracts';
import type {
  CreatedSession,
  DeviceContext,
  SessionService,
} from '@app/contracts';
import { AccountRepository } from '../persistence/account.repository.js';
import {
  LOCK_SECONDS,
  MAX_FAILED_ATTEMPTS,
  SignInAttemptStore,
} from '../persistence/sign-in-attempt.store.js';
import { IdentityEvents } from './identity-events.js';
import { hashEmail } from './one-time-code.js';
import { BCRYPT_SALT_ROUNDS } from './password/password-policy.js';
import { VERIFICATION_CODE_ISSUER } from './ports/verification-code-issuer.js';
import type { VerificationCodeIssuer } from './ports/verification-code-issuer.js';

/**
 * Compared against when the email has no account, so an unknown email takes
 * as long to reject as a wrong password.
 */
const DUMMY_HASH = bcrypt.hashSync(randomUUID(), BCRYPT_SALT_ROUNDS);

@Injectable()
export class SignInService {
  constructor(
    private readonly accounts: AccountRepository,
    private readonly attempts: SignInAttemptStore,
    private readonly events: IdentityEvents,
    @Inject(SESSION_SERVICE) private readonly sessions: SessionService,
    @Inject(VERIFICATION_CODE_ISSUER)
    private readonly verificationCodes: VerificationCodeIssuer,
  ) {}

  /**
   * Signs a traveller in. A wrong password and an unknown email get the same 401.
   * @returns the session created for the account
   */
  async signIn(
    rawEmail: string,
    password: string,
    device: DeviceContext,
  ): Promise<CreatedSession> {
    const email = rawEmail.toLowerCase();
    const emailHash = hashEmail(email);

    // Reserving the attempt is also the lock check. A refused attempt is not
    // counted and does not extend the lock.
    const reservation = await this.attempts.reserve(emailHash);
    if (!reservation.allowed) {
      throw locked(reservation.retryAfterSeconds);
    }

    const account = await this.accounts.findByEmail(email);
    const passwordMatches = await bcrypt.compare(
      password,
      account?.passwordHash ?? DUMMY_HASH,
    );

    if (!account || !passwordMatches) {
      if (reservation.attempt < MAX_FAILED_ATTEMPTS) {
        throw new DomainException(
          ErrorCode.INVALID_CREDENTIALS,
          HttpStatus.UNAUTHORIZED,
        );
      }
      // This failure reached the limit. The email is locked whether or not an
      // account exists, so the lock reveals nothing.
      const lockedNow = await this.attempts.lock(emailHash);
      if (lockedNow && account) {
        await this.events.publish(IdentityEventType.ACCOUNT_LOCKED, {
          accountId: account.id,
          email: account.email,
        });
      }
      throw locked(LOCK_SECONDS);
    }

    await this.attempts.clearFailures(emailHash);

    if (!account.verifiedAt) {
      const result = await this.verificationCodes.issue(account.id);
      throw new DomainException(
        ErrorCode.VERIFICATION_REQUIRED,
        HttpStatus.FORBIDDEN,
        result.issued
          ? { verificationCodeSent: true }
          : {
              verificationCodeSent: false,
              resendAfterSeconds: result.retryAfterSeconds,
            },
      );
    }

    const session = await this.sessions.createSession(account.id, device);
    await this.events.publish(IdentityEventType.TRAVELLER_SIGNED_IN, {
      accountId: account.id,
      sessionId: session.sessionId,
    });
    return session;
  }
}

/**
 * Builds the error for a locked email.
 * @returns an ACCOUNT_LOCKED (423) exception carrying the seconds left
 */
function locked(retryAfterSeconds: number): DomainException {
  return new DomainException(ErrorCode.ACCOUNT_LOCKED, HttpStatus.LOCKED, {
    retryAfterSeconds,
  });
}
