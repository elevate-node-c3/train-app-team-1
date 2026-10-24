import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import bcrypt from 'bcryptjs';
import { setTimeout as sleep } from 'node:timers/promises';
import { DomainException, SupportedLanguage } from '@app/common';
import {
  ACCOUNT_REVOCATION_SERVICE,
  ErrorCode,
  IdentityEventType,
} from '@app/contracts';
import type { AccountRevocationService } from '@app/contracts';
import { AccountRepository } from '../persistence/account.repository.js';
import { OneTimeCodeRepository } from '../persistence/one-time-code.repository.js';
import { SignInAttemptStore } from '../persistence/sign-in-attempt.store.js';
import { IdentityEvents } from './identity-events.js';
import {
  CODE_TTL_SECONDS,
  codeHashesMatch,
  generateCode,
  hashCode,
  hashEmail,
} from './one-time-code.js';
import { BCRYPT_SALT_ROUNDS } from './password/password-policy.js';

/**
 * Every forgot-password request takes at least this long, so the response
 * time does not reveal whether the email is registered.
 */
const FORGOT_MIN_DURATION_MS = 500;

@Injectable()
export class PasswordRecoveryService {
  private readonly logger = new Logger(PasswordRecoveryService.name);

  constructor(
    private readonly accounts: AccountRepository,
    private readonly codes: OneTimeCodeRepository,
    private readonly attempts: SignInAttemptStore,
    private readonly events: IdentityEvents,
    @Inject(ACCOUNT_REVOCATION_SERVICE)
    private readonly revocation: AccountRevocationService,
  ) {}

  /**
   * Sends a reset code if the email has an account. Looks the same either way.
   * @returns resolves after at least 500 ms, whether or not the account exists
   */
  async requestReset(
    rawEmail: string,
    language: SupportedLanguage,
  ): Promise<void> {
    const startedAt = Date.now();
    const account = await this.accounts.findByEmail(rawEmail.toLowerCase());

    if (account) {
      try {
        const code = generateCode();
        const expiresAt = new Date(Date.now() + CODE_TTL_SECONDS * 1000);
        await this.codes.replace(
          account.id,
          'password_reset',
          hashCode('password_reset', account.id, code),
          expiresAt,
        );
        await this.events.publish(
          IdentityEventType.PASSWORD_RESET_CODE_ISSUED,
          {
            accountId: account.id,
            email: account.email,
            code,
            expiresAt: expiresAt.toISOString(),
            language,
          },
        );
      } catch (err: unknown) {
        // Failing the request here would reveal that the account exists.
        this.logger.error(
          `Could not issue a reset code for account ${account.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    await sleep(Math.max(0, FORGOT_MIN_DURATION_MS - (Date.now() - startedAt)));
  }

  /**
   * Sets a new password using a reset code. A failing step never affects the
   * steps after it.
   * @returns resolves once the new password is saved; no session is created
   */
  async resetPassword(
    rawEmail: string,
    code: string,
    newPassword: string,
    confirmPassword: string,
  ): Promise<void> {
    if (newPassword !== confirmPassword) {
      throw new DomainException(
        ErrorCode.PASSWORD_MISMATCH,
        HttpStatus.BAD_REQUEST,
      );
    }

    const account = await this.accounts.findByEmail(rawEmail.toLowerCase());
    const stored = account
      ? await this.codes.findUsable(account.id, 'password_reset')
      : null;
    if (!account || !stored) {
      throw invalidCode();
    }

    const candidate = hashCode('password_reset', account.id, code);
    if (!codeHashesMatch(stored.codeHash, candidate)) {
      await this.codes.recordFailedAttempt(stored.id);
      throw invalidCode();
    }

    if (await bcrypt.compare(newPassword, account.passwordHash)) {
      throw new DomainException(
        ErrorCode.PASSWORD_REUSED,
        HttpStatus.BAD_REQUEST,
      );
    }

    const passwordHash = await bcrypt.hash(newPassword, BCRYPT_SALT_ROUNDS);
    const passwordChangedAt = new Date();
    const consumed = await this.codes.consumeForPasswordReset(
      stored,
      passwordHash,
      passwordChangedAt,
    );
    if (!consumed) {
      // Another request used the code first, or it expired in the meantime.
      throw invalidCode();
    }

    // The reset is committed: nothing below may undo or fail it.
    await this.attempts
      .clearAll(hashEmail(account.email))
      .catch(() =>
        this.logger.warn(
          `Could not clear the lockout of account ${account.id}`,
        ),
      );
    await this.revocation
      .revokeAll(account.id)
      .catch((err: unknown) =>
        this.logger.error(
          `Session revocation failed for account ${account.id}: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    await this.events.publish(IdentityEventType.PASSWORD_RESET, {
      accountId: account.id,
      email: account.email,
      passwordChangedAt: passwordChangedAt.toISOString(),
    });
  }
}

/**
 * Builds the error for a wrong, expired or used code.
 * @returns an INVALID_RESET_CODE (400) exception
 */
function invalidCode(): DomainException {
  return new DomainException(
    ErrorCode.INVALID_RESET_CODE,
    HttpStatus.BAD_REQUEST,
  );
}
