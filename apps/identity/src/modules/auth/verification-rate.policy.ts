import { Injectable } from '@nestjs/common';
import type { VerificationCodePurpose } from '@app/contracts';
import { VerificationRequestRepository } from './repositories/verification-request.repository.js';

export const VERIFICATION_RESEND_WAIT_SECONDS = 120;
export const VERIFICATION_HOURLY_LIMIT = 5;
export const VERIFICATION_WINDOW_SECONDS = 60 * 60;

export interface RateDecision {
  allowed: boolean;
  secondsRemaining: number;
}

/**
 * Durable, Postgres-backed counters. Redis is allowed to be down; an attacker
 * must not get unlimited attempts just because the edge cache degraded.
 */
@Injectable()
export class VerificationRatePolicy {
  constructor(private readonly requests: VerificationRequestRepository) {}

  async evaluate(
    email: string,
    purpose: VerificationCodePurpose,
    now: Date,
  ): Promise<RateDecision> {
    const latest = await this.requests.latestForEmail(email, purpose);
    if (latest) {
      const elapsedSeconds = Math.floor(
        (now.getTime() - latest.issuedAt.getTime()) / 1000,
      );
      const remaining = VERIFICATION_RESEND_WAIT_SECONDS - elapsedSeconds;
      if (remaining > 0) {
        return { allowed: false, secondsRemaining: remaining };
      }
    }

    const count = await this.requests.countSince(
      email,
      purpose,
      new Date(now.getTime() - VERIFICATION_WINDOW_SECONDS * 1000),
    );
    if (count >= VERIFICATION_HOURLY_LIMIT) {
      return { allowed: false, secondsRemaining: VERIFICATION_WINDOW_SECONDS };
    }

    return { allowed: true, secondsRemaining: 0 };
  }

  /** The response advertises the wait even when the caller did not ask again. */
  nextAllowedSeconds(): number {
    return VERIFICATION_RESEND_WAIT_SECONDS;
  }
}
