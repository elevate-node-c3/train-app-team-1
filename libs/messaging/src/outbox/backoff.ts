/**
 * The relay's own backoff: short first, capped fast, because a broker outage
 * should drain within seconds of recovery rather than minutes.
 *
 * `attemptCount` is the count *after* the failed attempt has been recorded.
 */
export const RELAY_BACKOFF_BASE_MS = 250;
export const RELAY_BACKOFF_MAX_MS = 5000;

export function relayBackoffMs(attemptCount: number): number {
  const exponent = Math.max(0, attemptCount - 1);
  return Math.min(RELAY_BACKOFF_BASE_MS * 2 ** exponent, RELAY_BACKOFF_MAX_MS);
}
