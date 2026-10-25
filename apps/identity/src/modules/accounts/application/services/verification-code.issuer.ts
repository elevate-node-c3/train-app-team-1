import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { VerificationCodePurpose } from '@app/contracts';
import type { TransactionContext } from '@app/common/persistence/unit-of-work.port.js';
import {
  OUTBOX,
  type OutboxPort,
} from '@app/messaging/outbox/outbox.port.js';
import type { Account } from '../../domain/account.js';
import { generateVerificationCode } from '../../domain/verification-code.hashing.js';
import { VerificationCode } from '../../domain/verification-code.js';
import { buildVerificationCodeIssued } from '../../domain/events/verification-code-issued.factory.js';
import { VerificationRequest } from '../../domain/verification-request.js';
import {
  VERIFICATION_CODE_REPOSITORY,
  type VerificationCodeRepositoryPort,
} from '../ports/verification-code.repository.port.js';
import {
  VERIFICATION_REQUEST_REPOSITORY,
  type VerificationRequestRepositoryPort,
} from '../ports/verification-request.repository.port.js';
import {
  TOKEN_SETTINGS,
  type TokenSettings,
} from '../token-settings.js';

export interface PreparedVerificationCode {
  code: VerificationCode;
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
    @Inject(VERIFICATION_CODE_REPOSITORY)
    private readonly codes: VerificationCodeRepositoryPort,
    @Inject(VERIFICATION_REQUEST_REPOSITORY)
    private readonly requests: VerificationRequestRepositoryPort,
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
    const plaintext = generateVerificationCode();
    return {
      code: VerificationCode.issue({
        id: randomUUID(),
        accountId,
        purpose,
        code: plaintext,
        ttlSeconds: ttl,
        issuedAt,
      }),
      plaintext,
      ttlSeconds: ttl,
    };
  }

  /** Replaces every live code for the purpose and records the request. */
  async issue(
    ctx: TransactionContext,
    options: {
      account: Pick<Account, 'id' | 'email' | 'language'>;
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
    await this.requests.record(
      ctx,
      new VerificationRequest(
        randomUUID(),
        options.email,
        options.accountId,
        options.purpose,
        options.now,
      ),
    );
  }
}
