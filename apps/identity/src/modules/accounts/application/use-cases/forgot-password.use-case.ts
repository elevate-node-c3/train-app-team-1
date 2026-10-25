import { Inject, Injectable } from '@nestjs/common';
import {
  type ForgotPasswordRequestDto,
  type ForgotPasswordResponseDto,
} from '@app/contracts';
import {
  UNIT_OF_WORK,
  type UnitOfWorkPort,
} from '@app/common/persistence/unit-of-work.port.js';
import {
  ACCOUNT_REPOSITORY,
  type AccountRepositoryPort,
} from '../ports/account.repository.port.js';
import { VerificationCodeIssuer } from '../services/verification-code.issuer.js';
import { VerificationRatePolicy } from '../services/verification-rate.policy.js';

export interface ForgotPasswordCommand extends ForgotPasswordRequestDto {
  correlationId: string;
}

/**
 * BR-09: the answer must not reveal whether the address exists. Every address
 * gets the same status, the same interval, and the same body. Only an address
 * with an account also gets a mail and an outbox row.
 */
@Injectable()
export class ForgotPasswordUseCase {
  constructor(
    @Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWorkPort,
    @Inject(ACCOUNT_REPOSITORY) private readonly accounts: AccountRepositoryPort,
    private readonly codes: VerificationCodeIssuer,
    private readonly ratePolicy: VerificationRatePolicy,
  ) {}

  async execute(
    command: ForgotPasswordCommand,
  ): Promise<ForgotPasswordResponseDto> {
    const now = new Date();
    const email = command.email.trim().toLowerCase();
    const decision = await this.ratePolicy.evaluate(
      email,
      'password_reset',
      now,
    );
    if (!decision.allowed) {
      return { secondsRemaining: decision.secondsRemaining };
    }

    const account = await this.accounts.findByEmail(email);
    const eligible = account && !account.isDisabled();
    const prepared = eligible
      ? this.codes.prepare(account.id, 'password_reset', now)
      : null;

    await this.unitOfWork.withTransaction(async (ctx) => {
      if (!account) {
        // The counter exists even for an unknown address; that is what keeps
        // the sixth request as slow as the first.
        await this.codes.recordRequest(ctx, {
          email,
          accountId: null,
          purpose: 'password_reset',
          now,
        });
        return;
      }

      const locked = await this.accounts.findByEmailForUpdate(ctx, email);
      if (!locked || locked.isDisabled() || !prepared) {
        await this.codes.recordRequest(ctx, {
          email,
          accountId: account.id,
          purpose: 'password_reset',
          now,
        });
        return;
      }

      await this.codes.issue(ctx, {
        account: locked,
        purpose: 'password_reset',
        prepared,
        correlationId: command.correlationId,
        now,
      });
    });

    return { secondsRemaining: this.ratePolicy.nextAllowedSeconds() };
  }
}
