import { Inject, Injectable } from '@nestjs/common';
import {
  ErrorCode,
  type ResendVerificationRequestDto,
  type ResendVerificationResponseDto,
} from '@app/contracts';
import { maskEmail } from '@app/common/logging/pii-redactor.js';
import {
  UNIT_OF_WORK,
  type UnitOfWorkPort,
} from '@app/common/persistence/unit-of-work.port.js';
import { AuthError } from '../auth-error.js';
import {
  ACCOUNT_REPOSITORY,
  type AccountRepositoryPort,
} from '../ports/account.repository.port.js';
import { VerificationCodeIssuer } from '../services/verification-code.issuer.js';
import { VerificationRatePolicy } from '../services/verification-rate.policy.js';

export interface ResendVerificationCommand
  extends ResendVerificationRequestDto {
  correlationId: string;
}

@Injectable()
export class ResendVerificationUseCase {
  constructor(
    @Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWorkPort,
    @Inject(ACCOUNT_REPOSITORY) private readonly accounts: AccountRepositoryPort,
    private readonly codes: VerificationCodeIssuer,
    private readonly ratePolicy: VerificationRatePolicy,
  ) {}

  async execute(
    command: ResendVerificationCommand,
  ): Promise<ResendVerificationResponseDto> {
    const now = new Date();
    const existing = await this.accounts.findByEmail(command.email);
    if (!existing) throw new AuthError(ErrorCode.RESOURCE_NOT_FOUND);
    if (existing.isDisabled()) throw new AuthError(ErrorCode.ACCOUNT_DISABLED);
    if (!existing.isPending()) throw new AuthError(ErrorCode.EMAIL_ALREADY_REGISTERED);

    const decision = await this.ratePolicy.evaluate(
      existing.email,
      'sign_up',
      now,
    );
    if (!decision.allowed) {
      throw new AuthError(
        ErrorCode.RESEND_TOO_SOON,
        'A verification code was issued recently',
        decision.secondsRemaining,
      );
    }

    const prepared = this.codes.prepare(existing.id, 'sign_up', now);

    await this.unitOfWork.withTransaction(async (ctx) => {
      const locked = await this.accounts.findByEmailForUpdate(
        ctx,
        existing.email,
      );
      if (!locked) throw new AuthError(ErrorCode.RESOURCE_NOT_FOUND);
      if (locked.isDisabled()) throw new AuthError(ErrorCode.ACCOUNT_DISABLED);
      if (!locked.isPending()) {
        throw new AuthError(ErrorCode.EMAIL_ALREADY_REGISTERED);
      }
      await this.codes.issue(ctx, {
        account: locked,
        purpose: 'sign_up',
        prepared,
        correlationId: command.correlationId,
        now,
      });
    });

    return {
      maskedEmail: maskEmail(existing.email),
      secondsRemaining: this.ratePolicy.nextAllowedSeconds(),
    };
  }
}
