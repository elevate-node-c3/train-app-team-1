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
 * One place issues every code. Sign-up, resend and password recovery must be
 * indistinguishable in TTL, hashing and rate accounting, or a difference
 * becomes an enumeration signal.
 */
@Injectable()
export class VerificationCodeIssuer {
  constructor(
    private readonly codes: VerificationCodeRepository,
    private readonly requests: VerificationRequestRepository,
    @Inject(OUTBOX) private readonly outbox: OutboxPort,
    @Inject(TOKEN_SETTINGS) private readonly tokens: TokenSettings,
  ) {}

  /**
   * Hash before the caller opens its transaction. scrypt is deliberately part
   * of the response latency, not of the row-lock lifetime.
   */
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
    // Deliberately before the timestamp: scrypt is not part of the delivery
    // budget, it is part of the sign-up response.
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

  /**
   * A request for an address with no account still consumes the hourly quota.
   * Without this row, "forgot password" would answer differently on the sixth
   * attempt only when the address exists.
   */
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
