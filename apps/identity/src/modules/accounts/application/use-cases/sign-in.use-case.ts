import { Inject, Injectable } from '@nestjs/common';
import {
  ErrorCode,
  type SignInRequestDto,
  type SignInResponseDto,
} from '@app/contracts';
import { maskEmail } from '@app/common/logging/pii-redactor.js';
import type { TransactionContext } from '@app/common/persistence/unit-of-work.port.js';
import {
  UNIT_OF_WORK,
  type UnitOfWorkPort,
} from '@app/common/persistence/unit-of-work.port.js';
import type { Account } from '../../domain/account.js';
import { SignInLockout } from '../../domain/sign-in-lockout.js';
import { AuthError } from '../auth-error.js';
import {
  ACCOUNT_REPOSITORY,
  type AccountRepositoryPort,
} from '../ports/account.repository.port.js';
import {
  PASSWORD_HASHER,
  type PasswordHasherPort,
} from '../ports/password-hasher.port.js';
import {
  SIGN_IN_LOCKOUT_REPOSITORY,
  type SignInLockoutRepositoryPort,
} from '../ports/sign-in-lockout.repository.port.js';
import { SessionIssuer, type IssuedTokens } from '../services/session.issuer.js';
import { VerificationRatePolicy } from '../services/verification-rate.policy.js';

export interface SignInCommand extends SignInRequestDto {
  correlationId: string;
}

type Outcome =
  | { failed: AuthError }
  | { account: Account; issued: IssuedTokens }
  | { account: Account; verification: true };

/**
 * Sign-in deliberately does the password comparison while holding the account
 * and lockout rows. That is slower than a read-only check, but it is the only
 * shape in which two concurrent wrong passwords cannot both read `9`.
 *
 * An unknown address takes the same bcrypt path against a dummy hash, so the
 * response time does not answer "does this account exist?".
 */
@Injectable()
export class SignInUseCase {
  private dummyHash: Promise<string> | null = null;

  constructor(
    @Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWorkPort,
    @Inject(ACCOUNT_REPOSITORY) private readonly accounts: AccountRepositoryPort,
    @Inject(PASSWORD_HASHER) private readonly passwords: PasswordHasherPort,
    @Inject(SIGN_IN_LOCKOUT_REPOSITORY)
    private readonly lockouts: SignInLockoutRepositoryPort,
    private readonly sessions: SessionIssuer,
    private readonly ratePolicy: VerificationRatePolicy,
  ) {}

  async execute(command: SignInCommand): Promise<SignInResponseDto> {
    const now = new Date();
    const email = command.email.trim().toLowerCase();
    const existingLockout = await this.lockouts.find(email);
    if (existingLockout?.isLocked(now)) {
      throw new AuthError(
        ErrorCode.ACCOUNT_LOCKED,
        'Too many failed sign-in attempts',
        existingLockout.secondsRemaining(now),
      );
    }

    const outcome = await this.unitOfWork.withTransaction(
      async (ctx): Promise<Outcome> => {
        const account = await this.accounts.findByEmailForUpdate(ctx, email);
        const lockout =
          (await this.lockouts.findForUpdate(ctx, email)) ??
          SignInLockout.empty(email, now);

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
        if (account.isDisabled()) {
          return { failed: new AuthError(ErrorCode.ACCOUNT_DISABLED) };
        }

        await this.lockouts.save(ctx, lockout.reset(now));

        if (!account.isVerified()) {
          return { account, verification: true };
        }

        const issued = await this.sessions.issue(ctx, account, now);
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

  private async checkPassword(
    account: Account | null,
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
    lockout: SignInLockout,
    now: Date,
  ): Promise<Outcome> {
    const updated = lockout.recordFailure(now);
    await this.lockouts.save(ctx, updated);
    if (updated.isLocked(now)) {
      return {
        failed: new AuthError(
          ErrorCode.ACCOUNT_LOCKED,
          'Too many failed sign-in attempts',
          updated.secondsRemaining(now),
        ),
      };
    }
    return { failed: new AuthError(ErrorCode.INVALID_CREDENTIALS) };
  }

  private dummyHashForTiming(): Promise<string> {
    this.dummyHash ??= this.passwords.hash(
      'train-app-not-a-real-account-password',
    );
    return this.dummyHash;
  }
}
