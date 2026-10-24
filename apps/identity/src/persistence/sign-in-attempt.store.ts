import { Injectable } from '@nestjs/common';
import { IdentityRedisService } from './identity-redis.service.js';

export const MAX_FAILED_ATTEMPTS = 10;
export const LOCK_SECONDS = 15 * 60;
const FAILURE_WINDOW_SECONDS = 15 * 60;

/** @returns the Redis key of the failed-attempt counter */
const failuresKey = (emailHash: string) =>
  `identity:signin:fail:{${emailHash}}`;
/** @returns the Redis key of the lock */
const lockKey = (emailHash: string) => `identity:signin:lock:{${emailHash}}`;

/**
 * Refuses while locked or while the counter is already at the maximum;
 * otherwise counts the attempt and refreshes the 15-minute window.
 * @returns {1, attemptNumber} if allowed, {0, retryAfterSeconds} if refused
 */
const RESERVE_ATTEMPT = `
local lockTtl = redis.call('TTL', KEYS[1])
if lockTtl ~= -2 then
  return {0, math.max(lockTtl, 1)}
end
local failures = tonumber(redis.call('GET', KEYS[2]) or '0')
if failures >= tonumber(ARGV[2]) then
  return {0, math.max(redis.call('TTL', KEYS[2]), 1)}
end
local attempt = redis.call('INCR', KEYS[2])
redis.call('EXPIRE', KEYS[2], ARGV[1])
return {1, attempt}
`;

export type AttemptReservation =
  | { allowed: true; attempt: number }
  | { allowed: false; retryAfterSeconds: number };

/**
 * Failed sign-in counting and locking, shared by every identity instance.
 * Each attempt is reserved atomically *before* the slow password check, so no
 * matter how many requests run in parallel, at most MAX_FAILED_ATTEMPTS
 * password checks happen per window.
 */
@Injectable()
export class SignInAttemptStore {
  constructor(private readonly redis: IdentityRedisService) {}

  /**
   * Reserves a sign-in attempt before the password is checked.
   * @returns the attempt number, or the seconds to wait if refused
   */
  async reserve(emailHash: string): Promise<AttemptReservation> {
    const [allowed, value] = await this.redis.run(
      (client) =>
        client.eval(
          RESERVE_ATTEMPT,
          2,
          lockKey(emailHash),
          failuresKey(emailHash),
          FAILURE_WINDOW_SECONDS,
          MAX_FAILED_ATTEMPTS,
        ) as Promise<[number, number]>,
    );
    return allowed === 1
      ? { allowed: true, attempt: value }
      : { allowed: false, retryAfterSeconds: value };
  }

  /**
   * Locks the email for 15 minutes, never extending an existing lock.
   * @returns true if this call set the lock
   */
  async lock(emailHash: string): Promise<boolean> {
    return this.redis.run(async (client) => {
      const set = await client.set(
        lockKey(emailHash),
        '1',
        'EX',
        LOCK_SECONDS,
        'NX',
      );
      await client.del(failuresKey(emailHash));
      return set === 'OK';
    });
  }

  /**
   * Resets the failed-attempt counter after a correct password.
   * @returns resolves once the counter is deleted
   */
  async clearFailures(emailHash: string): Promise<void> {
    await this.redis.run((client) => client.del(failuresKey(emailHash)));
  }

  /**
   * Removes the counter and the lock after a password reset.
   * @returns resolves once both keys are deleted
   */
  async clearAll(emailHash: string): Promise<void> {
    await this.redis.run((client) =>
      client.del(failuresKey(emailHash), lockKey(emailHash)),
    );
  }
}
