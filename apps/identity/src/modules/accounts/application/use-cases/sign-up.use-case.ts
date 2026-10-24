import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type {
  EventLanguage,
  SignUpRequestDto,
  SignUpResponseDto,
} from '@app/contracts';
import { VERIFICATION_CODE_DEFAULTS } from '@app/common/config/env.defaults.js';
import {
  UNIT_OF_WORK,
  type UnitOfWorkPort,
} from '@app/common/persistence/unit-of-work.port.js';
import {
  OUTBOX,
  type OutboxPort,
} from '@app/messaging/outbox/outbox.port.js';
import { Account } from '../../domain/account.js';
import { generateVerificationCode } from '../../domain/verification-code.hashing.js';
import { VerificationCode } from '../../domain/verification-code.js';
import { buildVerificationCodeIssued } from '../../domain/events/verification-code-issued.factory.js';
import {
  ACCOUNT_REPOSITORY,
  type AccountRepositoryPort,
} from '../ports/account.repository.port.js';
import {
  VERIFICATION_CODE_REPOSITORY,
  type VerificationCodeRepositoryPort,
} from '../ports/verification-code.repository.port.js';

export interface SignUpCommand extends SignUpRequestDto {
  /** Restored from CLS by the controller; the async hop carries it onward. */
  correlationId: string;
}

/** BR-56: anything that is not English falls back to Arabic. */
function languageOf(language: string | undefined): EventLanguage {
  return language === 'en' ? 'en' : 'ar';
}

function verificationCodeTtlSeconds(): number {
  return Number(
    process.env.VERIFICATION_CODE_TTL_SECONDS ??
      VERIFICATION_CODE_DEFAULTS.ttlSeconds,
  );
}

/**
 * The sign-up use-case. It writes the account, the verification code and the
 * outbox row in **one** transaction, and injects no publisher: the relay owns
 * delivery, so the dual-write bug has no call site here (ADR-0001).
 */
@Injectable()
export class SignUpUseCase {
  constructor(
    @Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWorkPort,
    @Inject(ACCOUNT_REPOSITORY) private readonly accounts: AccountRepositoryPort,
    @Inject(VERIFICATION_CODE_REPOSITORY)
    private readonly codes: VerificationCodeRepositoryPort,
    @Inject(OUTBOX) private readonly outbox: OutboxPort,
  ) {}

  async execute(command: SignUpCommand): Promise<SignUpResponseDto> {
    const now = new Date();
    const account = Account.register({
      id: randomUUID(),
      email: command.email,
      language: languageOf(command.language),
      createdAt: now,
    });

    const ttlSeconds = verificationCodeTtlSeconds();
    const plaintextCode = generateVerificationCode();
    // Hash before opening the transaction: scrypt is part of the response
    // latency, not part of the time the row lock is held.
    const code = VerificationCode.issue({
      id: randomUUID(),
      accountId: account.id,
      purpose: 'sign_up',
      code: plaintextCode,
      ttlSeconds,
      issuedAt: now,
    });

    const event = buildVerificationCodeIssued({
      eventId: randomUUID(),
      correlationId: command.correlationId,
      account: {
        id: account.id,
        email: account.email,
        language: account.language,
      },
      code: plaintextCode,
      purpose: 'sign_up',
      ttlSeconds,
      issuedAt: now,
    });

    await this.unitOfWork.withTransaction(async (ctx) => {
      await this.accounts.save(ctx, account);
      await this.codes.save(ctx, code);
      await this.outbox.append(ctx, event);
    });

    return {
      accountId: account.id,
      email: account.email,
      language: account.language,
    };
  }
}
