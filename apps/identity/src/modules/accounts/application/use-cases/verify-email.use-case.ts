import { Inject, Injectable } from '@nestjs/common';
import {
  ErrorCode,
  type VerifyEmailRequestDto,
  type VerifyEmailResponseDto,
} from '@app/contracts';
import { maskEmail } from '@app/common/logging/pii-redactor.js';
import type { TransactionContext } from '@app/common/persistence/unit-of-work.port.js';
import {
  UNIT_OF_WORK,
  type UnitOfWorkPort,
} from '@app/common/persistence/unit-of-work.port.js';
import {
  OUTBOX,
  type OutboxPort,
} from '@app/messaging/outbox/outbox.port.js';
import { randomUUID } from 'node:crypto';
import type { Account } from '../../domain/account.js';
import { buildEmailVerified } from '../../domain/events/identity-events.factory.js';
import { verifyVerificationCode } from '../../domain/verification-code.hashing.js';
import type { VerificationCode } from '../../domain/verification-code.js';
import { AuthError } from '../auth-error.js';
import {
  ACCOUNT_REPOSITORY,
  type AccountRepositoryPort,
} from '../ports/account.repository.port.js';
import {
  VERIFICATION_CODE_REPOSITORY,
  type VerificationCodeRepositoryPort,
} from '../ports/verification-code.repository.port.js';
import { SessionIssuer, type IssuedTokens } from '../services/session.issuer.js';

export interface VerifyEmailCommand extends VerifyEmailRequestDto {
  correlationId: string;
}

type Outcome =
  | { failed: AuthError }
  | { account: Account; issued: IssuedTokens };

/**
 * Verification is the sign-up completion point: the code is consumed, the
 * account becomes active, and the first session is created in the same
 * transaction. A wrong code still commits its attempt counter.
 */
@Injectable()
export class VerifyEmailUseCase {
  constructor(
    @Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWorkPort,
    @Inject(ACCOUNT_REPOSITORY) private readonly accounts: AccountRepositoryPort,
    @Inject(VERIFICATION_CODE_REPOSITORY)
    private readonly codes: VerificationCodeRepositoryPort,
    private readonly sessions: SessionIssuer,
    @Inject(OUTBOX) private readonly outbox: OutboxPort,
  ) {}

  async execute(command: VerifyEmailCommand): Promise<VerifyEmailResponseDto> {
    const now = new Date();

    const outcome = await this.unitOfWork.withTransaction(
      async (ctx): Promise<Outcome> => {
        const account = await this.accounts.findByEmailForUpdate(
          ctx,
          command.email,
        );
        if (!account) {
          return { failed: new AuthError(ErrorCode.INVALID_VERIFICATION_CODE) };
        }
        if (account.isDisabled()) {
          return { failed: new AuthError(ErrorCode.ACCOUNT_DISABLED) };
        }

        const code = await this.codes.findLatestLive(
          ctx,
          account.id,
          'sign_up',
          { forUpdate: true },
        );
        const failure = await this.checkCode(ctx, code, command.code, now);
        if (failure) return { failed: failure };

        const consumed = code!.consume(now);
        await this.codes.update(ctx, consumed);

        const verified = account.verifyEmail(now);
        await this.accounts.update(ctx, verified);

        const issued = await this.sessions.issue(ctx, verified, now);

        await this.outbox.append(
          ctx,
          buildEmailVerified({
            eventId: randomUUID(),
            correlationId: command.correlationId,
            occurredAt: now,
            accountId: verified.id,
            email: verified.email,
          }),
        );

        return { account: verified, issued };
      },
    );

    if ('failed' in outcome) throw outcome.failed;

    return {
      ...outcome.issued.tokens,
      accountId: outcome.account.id,
      maskedEmail: maskEmail(outcome.account.email),
    };
  }

  /**
   * Returns the error to raise *after* the transaction commits, or null when
   * the code matches. The attempt counter is the only write on the failure
   * path, and it must survive the rejected request (BR-05).
   */
  private async checkCode(
    ctx: TransactionContext,
    code: VerificationCode | null,
    submitted: string,
    now: Date,
  ): Promise<AuthError | null> {
    if (!code) {
      return new AuthError(ErrorCode.INVALID_VERIFICATION_CODE);
    }
    if (code.isConsumed()) {
      return new AuthError(ErrorCode.INVALID_VERIFICATION_CODE);
    }
    if (code.isExpired(now)) {
      return new AuthError(ErrorCode.VERIFICATION_CODE_EXPIRED);
    }
    if (!code.hasAttemptsRemaining()) {
      return new AuthError(ErrorCode.VERIFICATION_CODE_ATTEMPTS_EXHAUSTED);
    }

    if (
      !verifyVerificationCode(submitted, code.codeSalt, code.codeHash)
    ) {
      await this.codes.update(ctx, code.recordFailure());
      return new AuthError(ErrorCode.INVALID_VERIFICATION_CODE);
    }
    return null;
  }
}
