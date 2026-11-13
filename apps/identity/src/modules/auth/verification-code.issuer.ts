import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { VerificationCodePurpose } from '@app/contracts';
import type { TransactionContext } from '@app/common/persistence/unit-of-work.port.js';
import { OUTBOX, type OutboxPort } from '@app/messaging/outbox/outbox.port.js';
import type { AccountEntity } from './entities/account.entity.js';
import {
  VERIFICATION_CODE_MAX_ATTEMPTS,
  VerificationCodeEntity,
} from './entities/verification-code.entity.js';
import {
  generateVerificationCode,
  generateVerificationCodeSalt,
  hashVerificationCode,
} from './verification-code.hashing.js';
import {
  MAX_VERIFICATION_CODE_TTL_SECONDS,
  buildVerificationCodeIssued,
} from './verification-code-issued.factory.js';
import { VerificationCodeRepository } from './repositories/verification-code.repository.js';
import { VerificationRequestRepository } from './repositories/verification-request.repository.js';
import { TOKEN_SETTINGS, type TokenSettings } from './token-settings.js';

export interface PreparedVerificationCode {
  code: VerificationCodeEntity;
  plaintext: string;
  ttlSeconds: number;
}

/**
 * Use the same TTL, hashing and quotas across sign-up, resend and recovery
 * to avoid revealing whether an account exists.
 */
@Injectable()
export class VerificationCodeIssuer {
  constructor(
    private readonly codes: VerificationCodeRepository,
    private readonly requests: VerificationRequestRepository,
    @Inject(OUTBOX) private readonly outbox: OutboxPort,
    @Inject(TOKEN_SETTINGS) private readonly tokens: TokenSettings,
  ) {}

  /** Hash before the transaction so scrypt does not hold row locks. */
  prepare(
    accountId: string,
    purpose: VerificationCodePurpose,
    issuedAt: Date,
  ): PreparedVerificationCode {
    const ttl = this.tokens.verificationCodeTtlSeconds;
    if (
      !Number.isInteger(ttl) ||
      ttl < 1 ||
      ttl > MAX_VERIFICATION_CODE_TTL_SECONDS
    ) {
      throw new Error(
        `Verification code TTL must be between 1 and ${MAX_VERIFICATION_CODE_TTL_SECONDS} seconds`,
      );
    }

    const plaintext = generateVerificationCode();
    const salt = generateVerificationCodeSalt();
    // Keep scrypt time out of the delivery budget.
    const codeHash = hashVerificationCode(plaintext, salt);

    const code = new VerificationCodeEntity();
    code.id = randomUUID();
    code.accountId = accountId;
    code.purpose = purpose;
    code.codeHash = codeHash;
    code.codeSalt = salt;
    code.issuedAt = issuedAt;
    code.expiresAt = new Date(issuedAt.getTime() + ttl * 1000);
    code.consumedAt = null;
    code.attempts = 0;
    code.maxAttempts = VERIFICATION_CODE_MAX_ATTEMPTS;

    return { code, plaintext, ttlSeconds: ttl };
  }

  /** Replaces every live code for the purpose and records the request. */
  async issue(
    ctx: TransactionContext,
    options: {
      account: Pick<AccountEntity, 'id' | 'email' | 'language'>;
      purpose: VerificationCodePurpose;
      prepared: PreparedVerificationCode;
      correlationId: string;
      now: Date;
    },
  ): Promise<void> {
    await this.codes.consumeLive(
      ctx,
      options.account.id,
      [options.purpose],
      options.now,
    );
    await this.codes.save(ctx, options.prepared.code);
    await this.recordRequest(ctx, {
      email: options.account.email,
      accountId: options.account.id,
      purpose: options.purpose,
      now: options.now,
    });
    await this.outbox.append(
      ctx,
      buildVerificationCodeIssued({
        eventId: randomUUID(),
        correlationId: options.correlationId,
        account: options.account,
        code: options.prepared.plaintext,
        purpose: options.purpose,
        ttlSeconds: options.prepared.ttlSeconds,
        issuedAt: options.now,
      }),
    );
  }

  /** Unknown addresses count toward the quota to prevent account discovery. */
  async recordRequest(
    ctx: TransactionContext,
    options: {
      email: string;
      accountId: string | null;
      purpose: VerificationCodePurpose;
      now: Date;
    },
  ): Promise<void> {
    await this.requests.record(ctx, {
      id: randomUUID(),
      email: options.email,
      accountId: options.accountId,
      purpose: options.purpose,
      issuedAt: options.now,
    });
  }
}
